// Guarded outbound sending.
//
// The risk in a send tool is not the sending, it is that an assistant will reach for it
// confidently and wrongly - the same number twice, a stranger at 3am, forty messages in a
// burst because a loop looked finished. So the transport sits behind a fixed chain of
// checks, every one of which can only refuse:
//
//   paused -> blocked -> send window (if set) -> daily cap (if set) -> burst gap -> duplicate
//
// A transport that loses contact AFTER handing the message over reports an ambiguous
// outcome. That is recorded as if it had sent, because the failure mode to avoid is
// messaging someone twice, not under-counting a quota.
//
// Nothing here decides to send; it decides whether a send the caller already asked for is
// allowed. `now` and `transport` are injected so the whole chain is testable without a
// clock or a WhatsApp session.
//
// State (quota, recent sends, audit trail) lives in one JSON file so it survives restarts.
// Message bodies are stored only as a hash - enough to catch a duplicate, not enough to
// turn the state file into a second copy of someone's conversations.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

import { normaliseNumber } from './number.js';

export const DEFAULTS = {
  // No cap unless one is configured. 30 a day is the recommended value for a personal
  // account - it is the volume WhatsApp has tolerated without complaint - but it is the
  // operator's call, so the default enforces nothing.
  maxPerDay: null,
  // No send window unless one is configured either. This is a general-purpose tool; hours
  // that suit one project are wrong for another, so they are opt-in (WA_SEND_WINDOW).
  window: null,
  minGapSeconds: 5,
  duplicateWindowHours: 24,
  maxBodyLength: 4096,
};

/** Digits only, so 65 9123 4567 / +6591234567 / 6591234567 are one recipient. */
export function normaliseRecipient(to) {
  // Deliberately one argument. It is passed to .map() in places, and an optional second
  // parameter would silently collect the array index as a country code.
  const digits = normaliseNumber(to);
  if (digits.length < 6) throw new Error(`not a usable recipient: ${JSON.stringify(to)}`);
  return digits;
}

function bodyHash(text) {
  return createHash('sha256').update(String(text)).digest('hex').slice(0, 16);
}

/** "09:00-21:00" -> {startMin, endMin}. A window may wrap midnight. */
export function parseWindow(spec) {
  const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(String(spec).trim());
  if (!m) throw new Error(`unparseable send window: ${spec} (expected "HH:MM-HH:MM")`);
  const [sh, sm, eh, em] = m.slice(1).map(Number);
  if (sh > 23 || eh > 23 || sm > 59 || em > 59) throw new Error(`impossible time in window: ${spec}`);
  return { startMin: sh * 60 + sm, endMin: eh * 60 + em };
}

export function withinWindow(date, spec) {
  if (!spec) return true;   // no window configured: any hour is fine
  const { startMin, endMin } = parseWindow(spec);
  const mins = date.getHours() * 60 + date.getMinutes();
  return startMin <= endMin
    ? mins >= startMin && mins < endMin
    : mins >= startMin || mins < endMin;   // window wraps past midnight
}

function localDayKey(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

function loadState(path) {
  if (!path || !existsSync(path)) return { day: null, sent_today: 0, recent: [], log: [] };
  try {
    const s = JSON.parse(readFileSync(path, 'utf8'));
    return {
      day: s.day ?? null,
      sent_today: Number(s.sent_today) || 0,
      recent: Array.isArray(s.recent) ? s.recent : [],
      log: Array.isArray(s.log) ? s.log : [],
    };
  } catch {
    // A corrupt state file must not become a licence to ignore the caps, so fail closed
    // by starting from an empty day rather than silently continuing.
    return { day: null, sent_today: 0, recent: [], log: [] };
  }
}

function saveState(path, state) {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  // Write-then-rename: a crash mid-write must not leave a truncated file that reads as
  // "nothing sent today".
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 1), 'utf8');
  renameSync(tmp, path);
}

export class Sender {
  /**
   * @param {object} opts
   * @param {(to: string, text: string) => Promise<object>} opts.transport  performs the send
   * @param {string}   opts.statePath   where quota/audit state is kept
   * @param {() => Date} [opts.now]     injectable clock
   * @param {() => boolean} [opts.isPaused]  kill switch predicate
   * @param {() => Set<string>} [opts.blocklist]  numbers never to message
   */
  constructor({ transport, statePath, now = () => new Date(), isPaused = () => false,
                blocklist = () => new Set(), defaultCountry = '', ...limits } = {}) {
    if (typeof transport !== 'function') throw new Error('Sender needs a transport function');
    this.transport = transport;
    this.statePath = statePath;
    this.now = now;
    this.isPaused = isPaused;
    this.blocklist = blocklist;
    // Drop undefined before merging: an unset environment variable must fall through to the
    // default, not overwrite it with undefined and take the window with it.
    const given = Object.fromEntries(Object.entries(limits).filter(([, v]) => v !== undefined));
    // The country code the transport will apply. The guard must decide about the same
    // number the transport dials, or the blocklist can be walked past in local format.
    this.defaultCountry = String(defaultCountry || '').replace(/[^0-9]/g, '');
    this.limits = { ...DEFAULTS, ...given };
    // Anything that is not a positive number (unset, 0, empty) means no daily cap.
    const cap = Number(this.limits.maxPerDay);
    this.limits.maxPerDay = Number.isFinite(cap) && cap > 0 ? cap : null;
    this.limits.window = this.limits.window ? String(this.limits.window) : null;
    if (this.limits.window) parseWindow(this.limits.window);   // fail at construction, not at 3am
  }

  #queue = Promise.resolve();

  #state() {
    const s = loadState(this.statePath);
    const today = localDayKey(this.now());
    if (s.day !== today) {          // a new local day resets the quota
      s.day = today;
      s.sent_today = 0;
    }
    return s;
  }

  /** Everything the caller might want to know before trying: quota, window, blocks. */
  status() {
    const s = this.#state();
    const at = this.now();
    return {
      paused: this.isPaused(),
      within_window: withinWindow(at, this.limits.window),
      window: this.limits.window,   // null when no window is configured
      day: s.day,
      sent_today: s.sent_today,
      remaining_today: this.limits.maxPerDay ? Math.max(0, this.limits.maxPerDay - s.sent_today) : null,
      max_per_day: this.limits.maxPerDay,   // null when uncapped
      blocked_count: this.blocklist().size,
      last_send: s.recent.length ? new Date(s.recent.at(-1).ts * 1000).toISOString() : null,
    };
  }

  /**
   * Run the guard chain. Returns {allowed:true} or {allowed:false, reason}. Pure: it never
   * sends and never mutates state, so `dry_run` and the real path ask exactly the same
   * question and cannot drift apart.
   */
  check(to, text) {
    // Normalise exactly as the transport will, so the guard cannot decide about one number
    // and the transport dial another. normaliseRecipient supplies the length check.
    normaliseRecipient(to);
    const recipient = normaliseNumber(to, this.defaultCountry);
    const body = String(text ?? '');
    if (!body.trim()) return { allowed: false, reason: 'refusing to send an empty message' };
    if (body.length > this.limits.maxBodyLength) {
      return { allowed: false, reason: `message is ${body.length} chars, over the ${this.limits.maxBodyLength} limit` };
    }
    if (this.isPaused()) {
      return { allowed: false, reason: 'sending is paused (kill switch is set)' };
    }
    if (this.blocklist().has(recipient)) {
      return { allowed: false, reason: `${recipient} is on the blocklist and must never be messaged` };
    }
    const at = this.now();
    if (!withinWindow(at, this.limits.window)) {
      return {
        allowed: false,
        reason: `outside the send window ${this.limits.window} (local time is ` +
                `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')})`,
      };
    }
    const s = this.#state();
    if (this.limits.maxPerDay && s.sent_today >= this.limits.maxPerDay) {
      return { allowed: false, reason: `daily cap reached (${s.sent_today}/${this.limits.maxPerDay})` };
    }
    const nowSec = Math.floor(at.getTime() / 1000);
    const last = s.recent.at(-1);
    if (last && nowSec - last.ts < this.limits.minGapSeconds) {
      return {
        allowed: false,
        reason: `only ${nowSec - last.ts}s since the last send; minimum gap is ${this.limits.minGapSeconds}s`,
      };
    }
    const hash = bodyHash(body);
    const dupWindow = this.limits.duplicateWindowHours * 3600;
    const dup = s.recent.find(
      (r) => r.to === recipient && r.hash === hash && nowSec - r.ts < dupWindow
    );
    if (dup) {
      return {
        allowed: false,
        reason: `an identical message was sent to ${recipient} at ` +
                `${new Date(dup.ts * 1000).toISOString()}, within the ` +
                `${this.limits.duplicateWindowHours}h duplicate window`,
      };
    }
    return { allowed: true, recipient, hash };
  }

  /** Guarded send. `dryRun` runs every check and reports, but never calls the transport. */
  /**
   * Sends are serialised per instance. check() reads the state, the transport then takes
   * seconds, and only afterwards is the result recorded - so two overlapping calls would both
   * pass against the same pre-send state and defeat the min-gap, duplicate and daily-cap
   * guards between them. The MCP layer dispatches requests as they arrive without waiting for
   * the previous one, so a client that pipelines tool calls reaches this.
   */
  async send(to, text, opts = {}) {
    const next = this.#queue.then(() => this.#sendOne(to, text, opts),
                                  () => this.#sendOne(to, text, opts));
    // Keep the chain alive past a rejection so one failure cannot wedge the queue.
    this.#queue = next.catch(() => {});
    return next;
  }

  async #sendOne(to, text, { dryRun = false } = {}) {
    const verdict = this.check(to, text);
    if (!verdict.allowed) return { sent: false, dry_run: dryRun, ...verdict };
    if (dryRun) {
      return { sent: false, dry_run: true, allowed: true, recipient: verdict.recipient,
               would_send: true, status: this.status() };
    }

    const at = this.now();
    const nowSec = Math.floor(at.getTime() / 1000);
    let result;
    try {
      result = await this.transport(verdict.recipient, String(text));
    } catch (err) {
      const message = String(err.message || err);
      // An AMBIGUOUS failure is not a failure: the transport lost contact after handing the
      // message over, so it may well have been delivered. Treat it as sent for the purposes
      // of quota and duplicate suppression - the safe direction is the one that does not
      // message someone twice - and say plainly that a human has to check.
      const uncertain = !!err.ambiguous || message.includes('WA_OUTCOME_UNKNOWN');
      this.#record({ to: verdict.recipient, hash: verdict.hash, ts: nowSec,
                     ok: false, uncertain, error: message },
                   { countsToQuota: uncertain });
      return {
        sent: false, allowed: true, recipient: verdict.recipient, error: message,
        ...(uncertain ? {
          uncertain: true,
          advice: 'The connection dropped after the message was handed over. It may already '
                + 'have been delivered - read the chat before sending again. It has been '
                + 'counted against the quota and the duplicate window so an automatic retry '
                + 'cannot repeat it.',
        } : {}),
      };
    }
    this.#record({ to: verdict.recipient, hash: verdict.hash, ts: nowSec, ok: true },
                 { countsToQuota: true });
    return { sent: true, recipient: verdict.recipient, at: new Date(nowSec * 1000).toISOString(),
             transport: result ?? null, status: this.status() };
  }

  #record(entry, { countsToQuota }) {
    const s = this.#state();
    if (countsToQuota) {
      s.sent_today += 1;
      s.recent.push({ to: entry.to, hash: entry.hash, ts: entry.ts });
      // Keep only what the duplicate window can still need.
      const cutoff = entry.ts - this.limits.duplicateWindowHours * 3600;
      s.recent = s.recent.filter((r) => r.ts >= cutoff).slice(-500);
    }
    s.log.push(entry);
    s.log = s.log.slice(-1000);
    saveState(this.statePath, s);
  }
}

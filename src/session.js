// Owner of ONE live WhatsApp Web session, and the in-page primitives that read it.
//
// This is the part that makes the server a scraper rather than a viewer of someone else's
// scrape. It links its OWN device (its own LocalAuth profile under WA_SESSION_DIR), so it
// never contends with any other tool for a login.
//
// Two facts about WhatsApp Web shape everything here:
//
//   1. Most of whatsapp-web.js's high-level wrappers (getChats, getChatById, fetchMessages,
//      downloadMedia) have thrown a minified `r` on every WhatsApp Web build since mid-2026.
//      Only direct access to the page's own modules - window.require('WAWebChatCollection')
//      and friends - still works. So reads go through page.evaluate, not the library.
//      getNumberId / sendMessage / getContacts are the wrappers that still function.
//
//   2. A freshly connected device's message store is NOT the phone's history. It starts
//      near-empty and hydrates from the phone over minutes to hours, best-effort, and our
//      own outbound to a chat we created never syncs back at all. Every reader here says
//      so in its docs; nothing here pretends the store is complete.
//
// Every page.evaluate is serialised through one queue: the page is a single JS thread and
// overlapping evaluates against the live store corrupt each other's paging.

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { normaliseNumber } from './number.js';
import { join, resolve } from 'node:path';

export const STATES = Object.freeze({
  NOT_STARTED: 'not_started',
  CONNECTING: 'connecting',
  NEEDS_QR: 'needs_qr',
  READY: 'ready',
  DISCONNECTED: 'disconnected',
  FAILED: 'failed',
});

// Where Chrome usually lives, per platform. Only a default: WA_CHROME overrides it, and a
// path that does not exist is reported by name rather than failing obscurely.
const CHROME_BY_PLATFORM = {
  win32: [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  ],
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ],
  linux: [
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium',
  ],
};

/** The first Chrome present on this machine, else the platform's usual path. */
export function defaultChromePath(platform = process.platform, exists = existsSync) {
  const candidates = CHROME_BY_PLATFORM[platform] ?? CHROME_BY_PLATFORM.linux;
  return candidates.find((p) => { try { return exists(p); } catch { return false; } })
    ?? candidates[0];
}

// whatsapp-web.js is NOT used to reach a linked session. Its initialize() awaits a
// page.evaluate across WhatsApp's own `?post_logout=1` self-reset, so on an unlinked profile
// the reset destroys the execution context mid-call and it throws "Execution context was
// destroyed" before ever emitting a QR. Measured 06/09/26 on build 2.3000.10469xx: 0 QRs in
// 15 fresh attempts, with or without a version pin, headless or headed. Driving puppeteer
// directly and polling the page survives that navigation - 5 of 5 fresh profiles reached a
// scannable QR on the first try - so this owns the browser itself.
const WEB_URL = 'https://web.whatsapp.com/';
const WEB_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_14_0) AppleWebKit/537.36'
  + ' (KHTML, like Gecko) Chrome/101.0.4951.67 Safari/537.36';

/**
 * What the WhatsApp Web tab is showing right now. Serialised into the page, so it must stay
 * self-contained.
 *
 * DOM ONLY - this must never call window.require. Touching WhatsApp's module loader while the
 * app is still starting destabilises its own boot: every probe that did so (this function's
 * first version, and whatsapp-web.js's ExposeAuthStore) drove the page into `?post_logout=1`
 * and then "A database error occurred on your browser", while every DOM-only probe reached a
 * QR. Module access is safe once the app is up, not before.
 */
const PAGE_STATE = () => {
  const txt = document.body ? (document.body.innerText || '') : '';
  if (/database error/i.test(txt)) return { screen: 'dberr' };
  const canvas = document.querySelector('canvas');
  if (document.querySelector('div[data-ref]') || (canvas && canvas.width > 100)) {
    return { screen: 'qr' };
  }
  if (document.querySelector('#pane-side')) return { screen: 'linked' };
  return { screen: 'boot' };
};

/**
 * A media message carries a base64 THUMBNAIL in .body and the real text in .caption, so a
 * naive reader sees a wall of JPEG bytes where the caption should be. Prefer the caption
 * and drop thumbnail-shaped bodies outright.
 *
 * NOTE: page.evaluate callbacks are serialised and re-parsed inside the browser, so they
 * cannot close over this function. The readers below re-implement it inline. This copy is
 * what the tests exercise; if you change one, change both.
 */
export function realBody(caption, body) {
  const c = String(caption ?? '').trim();
  if (c) return c;
  const b = String(body ?? '');
  return (b.startsWith('/9j/') || b.startsWith('iVBOR')) ? '' : b;
}

/**
 * The phone number behind a chat. Since the 2025 privacy change most direct chats are keyed
 * by an opaque @lid, and the number lives on chat.contact.phoneNumber; legacy chats are
 * keyed by number@c.us. Returns digits or ''.
 *
 * NOTE: mirrored by hand inside each page.evaluate below, for the same reason as realBody.
 */
export function numberOfChat(chat) {
  try {
    const ct = chat && chat.contact;
    if (ct && ct.phoneNumber) return String(ct.phoneNumber).split('@')[0].replace(/\D/g, '');
    const id = chat && chat.id;
    if (id && id.server === 'c.us' && id.user) return String(id.user).replace(/\D/g, '');
  } catch { /* fall through */ }
  return '';
}

// Re-exported so existing importers keep working; the definition is shared with the sender,
// which must decide about a recipient using the very value this dials. See src/number.js.
export { normaliseNumber } from './number.js';

/** Runs async jobs strictly one at a time, in submission order. */
export class SingleFlight {
  #tail = Promise.resolve();
  run(fn) {
    const next = this.#tail.then(fn, fn);
    // Keep the chain alive past a rejection so one failed job cannot block the queue.
    this.#tail = next.catch(() => {});
    return next;
  }
}

export class Session {
  /**
   * @param {object} o
   * @param {string}  o.dataDir           login profile directory (created if missing)
   * @param {string}  [o.chromePath]      Chrome executable
   * @param {boolean} [o.headless=true]
   * @param {string}  [o.defaultCountry]  digits prepended to bare local numbers, e.g. '65'
   * @param {number}  [o.settleQuietMs=20000]  wait for the store to stop growing after connect
   * @param {number}  [o.settleMaxMs=120000]
   * @param {number}  [o.startTimeoutMs=240000] give up waiting for a linked, settled session
   * @param {(...a: any[]) => void} [o.log]
   */
  constructor(o = {}) {
    if (!o.dataDir) throw new Error('Session needs a dataDir for its login profile');
    this.dataDir = resolve(o.dataDir);
    // Chrome's own profile IS the login: linking writes the session into this directory and
    // reopening it is already authenticated. Named `session` to match the layout
    // whatsapp-web.js's LocalAuth used, so a profile linked by either tool still opens.
    this.profileDir = join(this.dataDir, 'session');
    this.linkedMarker = join(this.dataDir, '.linked');
    this.chromePath = o.chromePath || defaultChromePath();
    this.headless = o.headless !== false;
    this.defaultCountry = String(o.defaultCountry || '').replace(/[^0-9]/g, '');
    this.settleQuietMs = o.settleQuietMs ?? 20_000;
    this.settleMaxMs = o.settleMaxMs ?? 120_000;
    this.startTimeoutMs = o.startTimeoutMs ?? 240_000;
    this.log = o.log || ((...a) => console.error(new Date().toISOString().slice(11, 19), ...a));

    this.state = STATES.NOT_STARTED;
    this.qrPath = join(this.dataDir, 'qr.png');
    this.qrHtmlPath = join(this.dataDir, 'qr.html');
    this.lastError = null;
    this.browser = null;
    this.page = null;
    this.phone = null;
    this.#flight = new SingleFlight();
    this.#readyPromise = null;
  }

  #flight; #readyPromise;

  status() {
    return {
      state: this.state,
      data_dir: this.dataDir,
      needs_qr: this.state === STATES.NEEDS_QR,
      qr_png: this.state === STATES.NEEDS_QR ? this.qrPath : null,
      qr_html: this.state === STATES.NEEDS_QR ? this.qrHtmlPath : null,
      phone: this.phone,
      last_error: this.lastError,
    };
  }

  /**
   * Start the browser if it is not running and wait until the device is linked and its store
   * has settled. Concurrent callers share one attempt. When a QR is needed the wait ends in
   * an error naming the PNG, so the caller can tell the human where to point their phone;
   * status() carries the same paths.
   */
  ensureReady() {
    if (this.state === STATES.READY && !this.#alive()) {
      // Ready is a claim about a live browser; if it died, stop claiming it.
      this.state = STATES.DISCONNECTED;
      this.lastError = 'the browser exited; the session will be restarted on the next call';
    }
    if (this.state === STATES.READY) return Promise.resolve();
    if (this.#readyPromise) return this.#readyPromise;
    this.#readyPromise = this.#start().finally(() => { this.#readyPromise = null; });
    return this.#readyPromise;
  }

  async #start() {
    mkdirSync(this.profileDir, { recursive: true });
    if (!existsSync(this.chromePath)) {
      this.state = STATES.FAILED;
      this.lastError = 'Chrome not found at ' + this.chromePath + ' (set WA_CHROME)';
      throw new Error(this.lastError);
    }
    // Loaded lazily so a read-only deployment never pays for puppeteer. puppeteer-core,
    // not puppeteer: this always drives a real installed Chrome via executablePath, so the
    // bundled-Chromium download is pure weight - and it was the source of the only
    // advisories this project had.
    const puppeteer = (await import('puppeteer-core')).default;

    if (this.browser) await this.close();
    this.state = STATES.CONNECTING;
    this.lastError = null;

    // Reaching a QR is not reliable on demand: WhatsApp Web intermittently answers a fresh,
    // unlinked profile with `?post_logout=1` and then a browser database error, and it does so
    // in streaks - the identical boot measured 5/5 QRs in one window and 0/5 an hour later.
    // So retry for as long as the caller is willing to wait rather than a fixed few times.
    const deadline = Date.now() + this.startTimeoutMs;
    for (let attempt = 1; ; attempt += 1) {
      const outcome = await this.#boot(puppeteer, deadline);
      if (outcome === 'ready') return;
      // A wedged IndexedDB ("A database error occurred on your browser") is only recoverable
      // by discarding the profile. Safe while nothing is linked yet; never once it is, because
      // the profile IS the login.
      if (outcome === 'dberr' && !existsSync(this.linkedMarker) && Date.now() < deadline - 20_000) {
        this.log('WhatsApp Web wedged its database (boot ' + attempt
          + ') - discarding the unlinked profile and retrying');
        await this.close();
        rmSync(this.profileDir, { recursive: true, force: true });
        mkdirSync(this.profileDir, { recursive: true });
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      if (this.state !== STATES.NEEDS_QR) this.state = STATES.FAILED;
      throw new Error(this.lastError || 'session did not become ready (' + outcome + ')');
    }
  }

  /**
   * One browser boot, driven straight through puppeteer rather than whatsapp-web.js - see the
   * note at the top of this file for why that library cannot reach a QR at all.
   *
   * @returns {Promise<'ready'|'dberr'|'qr'|'timeout'>}
   */
  async #boot(puppeteer, deadline) {
    try {
      return await this.#bootOnce(puppeteer, deadline);
    } catch (e) {
      // launch() succeeded but something after it threw - a goto timeout, a DNS failure. The
      // browser is live and nothing else holds a reference to it, so close it rather than
      // leaving an orphaned Chrome behind until the next attempt happens to clean up.
      await this.close();
      throw e;
    }
  }

  async #bootOnce(puppeteer, deadline) {
    this.browser = await puppeteer.launch({
      headless: this.headless,
      executablePath: this.chromePath,
      userDataDir: this.profileDir,
      defaultViewport: { width: 1280, height: 900 },
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
    });
    this.page = (await this.browser.pages())[0] ?? (await this.browser.newPage());
    // Report the drop the moment it happens rather than at the next call.
    this.browser.on('disconnected', () => {
      if (this.state === STATES.READY || this.state === STATES.CONNECTING) {
        this.state = STATES.DISCONNECTED;
        this.lastError = 'the browser disconnected';
      }
    });
    await this.page.setUserAgent(WEB_USER_AGENT);
    await this.page.goto(WEB_URL, { waitUntil: 'load', timeout: 60_000, referer: 'https://whatsapp.com/' });

    let announced = false;
    let reloads = 0;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1500));
      let s;
      // WhatsApp self-navigates during boot; an evaluate caught by that is simply retried.
      try { s = await this.page.evaluate(PAGE_STATE); } catch { continue; }

      if (s.screen === 'dberr') {
        this.lastError = 'WhatsApp Web reported a browser database error';
        // Cheap recovery first: WhatsApp usually re-initialises its storage on a reload. Only
        // give up on the browser (and let #start discard an unlinked profile) if that fails.
        if (reloads < 2 && !existsSync(this.linkedMarker)) {
          reloads += 1;
          this.log('WhatsApp Web reported a database error - reloading the page (' + reloads + '/2)');
          try { await this.page.reload({ waitUntil: 'load', timeout: 60_000 }); } catch { /* retried */ }
          continue;
        }
        return 'dberr';
      }
      if (s.screen === 'qr') {
        this.state = STATES.NEEDS_QR;
        await this.#captureQr();
        if (!announced) {
          announced = true;
          this.log('QR needed - scan', this.qrPath, '(auto-refreshing page:', this.qrHtmlPath + ')');
        }
        continue;
      }
      if (s.screen === 'linked') {
        writeFileSync(this.linkedMarker, new Date().toISOString(), 'utf8');
        this.log('linked - waiting for the store to settle');
        await this.#settle();
        // Safe to reach into the app's own modules now that it is up, but not before.
        this.phone = await this.#readPhone();
        this.state = STATES.READY;
        // The linked number is deliberately NOT logged: MCP clients persist stderr to files
        // that end up attached to bug reports. wa_session_status still reports it on request.
        this.log('store settled; session ready');
        return 'ready';
      }
    }
    const secs = Math.round(this.startTimeoutMs / 1000);
    if (this.state === STATES.NEEDS_QR) {
      this.lastError = 'the QR at ' + this.qrPath + ' was not scanned within ' + secs + 's';
      return 'qr';
    }
    this.lastError = 'not ready after ' + secs + 's (state: ' + this.state + ')';
    return 'timeout';
  }

  /** The linked device's own number. Only valid once the app has finished starting. */
  async #readPhone() {
    try {
      return await this.page.evaluate(() => {
        const me = window.require('WAWebUserPrefsMeUser').getMaybeMePnUser();
        return me && me.user ? String(me.user) : null;
      });
    } catch {
      return null;
    }
  }

  /**
   * Save the on-screen QR as an image. It is a screenshot of the page's own canvas, which is
   * the QR itself, so nothing has to reconstruct the login payload to render it.
   */
  async #captureQr() {
    try {
      const el = await this.page.$('canvas');
      if (el) await el.screenshot({ path: this.qrPath });
      writeFileSync(this.qrHtmlPath, QR_HTML, 'utf8');
    } catch (e) {
      this.log('could not capture the QR image:', e.message);
    }
  }

  /**
   * A freshly connected device receives its queued messages only AFTER connecting, so an
   * immediate read sees a half-filled store. Wait until the number of loaded messages stops
   * growing for settleQuietMs, or settleMaxMs passes.
   */
  async #settle() {
    const start = Date.now();
    let last = -1;
    let lastChange = Date.now();
    while (Date.now() - start < this.settleMaxMs) {
      await new Promise((r) => setTimeout(r, 1000));
      let n;
      try {
        n = await this.page.evaluate(() => {
          const CC = window.require('WAWebChatCollection').ChatCollection;
          let total = 0;
          for (const c of CC.getModelsArray()) {
            try { total += c.msgs.getModelsArray().length; } catch (e) { /* unreadable chat */ }
          }
          return total;
        });
      } catch { continue; }
      if (n !== last) { last = n; lastChange = Date.now(); }
      else if (Date.now() - lastChange >= this.settleQuietMs) return;
    }
  }

  /**
   * True when the browser we think we own has actually gone away. Chrome can be closed,
   * crash, or be killed; puppeteer notices, but nothing else here would.
   */
  #alive() {
    try {
      return !!(this.browser && this.browser.connected !== false
                && this.page && !this.page.isClosed());
    } catch {
      return false;
    }
  }

  /** A puppeteer error that means the tab or browser died, rather than the page throwing. */
  static #isDisconnect(e) {
    return /Target closed|Session closed|Protocol error|detached Frame|Connection closed|browser has disconnected/i
      .test(String((e && e.message) || e));
  }

  /** Marks an error whose operation may or may not have completed. Never retry one. */
  static AMBIGUOUS = 'WA_OUTCOME_UNKNOWN';

  /**
   * One attempt, no retry. For anything with a side effect: if the browser dies after the
   * page acted but before the result came back, retrying would do it twice. The caller gets
   * an error tagged AMBIGUOUS instead, and has to resolve it by looking at the world.
   */
  async evaluateOnce(fn, ...args) {
    await this.ensureReady();
    if (!this.#alive()) {
      this.state = STATES.DISCONNECTED;
      await this.close();
      await this.ensureReady();
    }
    try {
      return await this.#flight.run(() => this.page.evaluate(fn, ...args));
    } catch (e) {
      if (!Session.#isDisconnect(e)) throw e;
      this.state = STATES.DISCONNECTED;
      const err = new Error(
        `${Session.AMBIGUOUS}: the browser dropped mid-call, so this may or may not have `
        + `completed - check before trying again (${(e && e.message) || e})`);
      err.ambiguous = true;
      throw err;
    }
  }

  /**
   * Serialised page.evaluate against a ready session, for READS ONLY.
   *
   * Recovers from a dropped browser: a session that has died is restarted once and the call
   * retried, so a crashed or closed Chrome costs one slow call instead of breaking every
   * later one until the server is restarted. Anything with a side effect must use
   * evaluateOnce - a retried read is free, a retried send is a second message.
   */
  async evaluate(fn, ...args) {
    await this.ensureReady();
    if (!this.#alive()) {
      this.log('the browser is gone - restarting the session');
      this.state = STATES.DISCONNECTED;
      await this.close();
      await this.ensureReady();
    }
    try {
      return await this.#flight.run(() => this.page.evaluate(fn, ...args));
    } catch (e) {
      if (!Session.#isDisconnect(e)) throw e;
      this.log('lost the browser mid-call - restarting the session and retrying once');
      this.state = STATES.DISCONNECTED;
      await this.close();
      await this.ensureReady();
      return this.#flight.run(() => this.page.evaluate(fn, ...args));
    }
  }

  async close() {
    if (this.browser) {
      try { await this.browser.close(); } catch { /* already gone */ }
      this.browser = null;
      this.page = null;
    }
    this.state = STATES.NOT_STARTED;
  }

  // ---------------------------------------------------------------- live reads

  /** Chats as the device currently holds them. `query` matches the chat name. */
  async listChats({ query, limit = 50, groupsOnly = false, directOnly = false } = {}) {
    const rows = await this.evaluate((q, lim, gOnly, dOnly) => {
      const CC = window.require('WAWebChatCollection').ChatCollection;
      const qq = String(q || '').toLowerCase();
      const out = [];
      for (const c of CC.getModelsArray()) {
        if (!c.id) continue;
        const isGroup = c.id.server === 'g.us';
        if (gOnly && !isGroup) continue;
        if (dOnly && isGroup) continue;
        const name = String(c.formattedTitle || c.name || '');
        if (qq && !name.toLowerCase().includes(qq)) continue;
        let number = '';
        try {
          const ct = c.contact;
          if (ct && ct.phoneNumber) number = String(ct.phoneNumber).split('@')[0];
          else if (c.id.server === 'c.us') number = c.id.user || '';
        } catch (e) {}
        const ms = c.msgs.getModelsArray();
        const last = ms.length ? ms[ms.length - 1] : null;
        out.push({
          id: String(c.id._serialized || c.id),
          name, is_group: isGroup, number: number.replace(/\D/g, ''),
          unread: Number(c.unreadCount || 0),
          loaded_messages: ms.length,
          last_ts: last ? Number(last.t || 0) : 0,
        });
      }
      out.sort((a, b) => b.last_ts - a.last_ts);
      return out.slice(0, lim);
    }, query ?? '', Math.max(1, Math.min(Number(limit) || 50, 500)), !!groupsOnly, !!directOnly);
    return rows.map((r) => ({ ...r, last: r.last_ts ? new Date(r.last_ts * 1000).toISOString() : null }));
  }

  /**
   * Messages from one chat, addressed by `chatId` (exact), `number`, or `chat` (name
   * substring). Pages history back until `since` is covered or nothing more loads, then
   * returns the newest `limit` oldest-first.
   */
  async readChat({ chatId, number, chat, limit = 50, since, maxPages } = {}) {
    const num = number ? normaliseNumber(number, this.defaultCountry) : '';
    if (!chatId && !num && !chat) throw new Error('readChat needs chatId, number or chat');
    const sinceTs = since ? Math.floor(new Date(since).getTime() / 1000) : 0;
    if (since && Number.isNaN(sinceTs)) throw new Error(`unparseable since: ${since}`);
    const pages = Math.max(12, Math.min(Number(maxPages) || Math.ceil(limit / 40) + 12, 400));
    const res = await this.evaluate(async (cid, num, nameQ, lim, sinceTs, maxPages) => {
      const CC = window.require('WAWebChatCollection').ChatCollection;
      const q = String(nameQ || '').toLowerCase();
      let chat = null;
      for (const c of CC.getModelsArray()) {
        if (!c.id) continue;
        const ser = String(c.id._serialized || c.id);
        if (cid && ser === cid) { chat = c; break; }
        if (num) {
          let pn = '';
          try {
            const ct = c.contact;
            if (ct && ct.phoneNumber) pn = String(ct.phoneNumber).split('@')[0];
            else if (c.id.server === 'c.us') pn = c.id.user || '';
          } catch (e) {}
          if (pn.replace(/\D/g, '') === num) { chat = c; break; }
        }
        if (q && String(c.formattedTitle || c.name || '').toLowerCase().includes(q)) { chat = c; break; }
      }
      if (!chat) return { found: false };
      // Page back until the loaded window covers `since` (or we have enough for `limit`).
      // Declared out here so the result can report how deep it actually got.
      let guard = 0;
      let pagingError = null;
      try {
        const loader = (window.Store && window.Store.ConversationMsgs)
          || window.require('WAWebChatLoadMessages');
        // Each call pages back roughly one screen, so the page budget - not `limit` - is
        // what decides how far back a busy group can be read. Scale it to the window asked
        // for instead of stopping at a fixed 12.
        while (guard++ < maxPages) {
          const ms = chat.msgs.getModelsArray();
          const oldest = ms.length ? Number(ms[0].t || 0) : 0;
          const enough = sinceTs ? (oldest && oldest < sinceTs) : (ms.length >= lim);
          if (enough) break;
          const more = await loader.loadEarlierMsgs(chat);
          if (!more || !more.length) break;   // reached the start of what the device holds
        }
      } catch (e) {
        // Swallowing this made a broken pager look exactly like the start of the chat: the
        // caller got a short history and no reason to doubt it. WhatsApp's in-page modules
        // move between builds, and as of 07/09/26 loadEarlierMsgs throws on every call
        // (it reaches for page context a headless boot does not set up), so this is the
        // normal path today rather than a rare one. Say so instead of pretending.
        pagingError = String((e && e.message) || e);
      }
      const realBody = (m) => {
        const cap = String(m.caption || m.__x_caption || '').trim();
        if (cap) return cap;
        const b = String(m.body || '');
        return (b.startsWith('/9j/') || b.startsWith('iVBOR')) ? '' : b;
      };
      const all = chat.msgs.getModelsArray()
        .filter((m) => !sinceTs || Number(m.t || 0) >= sinceTs)
        .map((m) => ({
          id: m.id ? String(m.id._serialized || m.id) : '',
          ts: Number(m.t || 0),
          from_me: !!(m.id && m.id.fromMe),
          author: m.author ? String(m.author._serialized || m.author)
                           : (m.from ? String(m.from._serialized || m.from) : ''),
          type: String(m.type || ''),
          has_media: !!(m.mediaKey || m.directPath),
          mimetype: m.mimetype || null,
          body: realBody(m),
        }))
        .filter((m) => m.body || m.has_media);
      const tail = all.slice(-lim);
      return {
        found: true,
        pages_used: guard,
        hit_page_budget: guard >= maxPages,   // true = more history is probably still behind
        // Non-null means paging stopped because something broke, NOT because the chat ended.
        // The messages returned are whatever the device had already loaded; ask the phone to
        // push more with wa_request_history, wait a few seconds, then read again.
        paging_error: pagingError,
        chat: { id: String(chat.id._serialized || chat.id), name: String(chat.formattedTitle || chat.name || ''),
                is_group: chat.id.server === 'g.us' },
        loaded: all.length,
        messages: tail,
      };
    }, chatId ?? '', num, chat ?? '', Math.max(1, Math.min(Number(limit) || 50, 100_000)), sinceTs, pages);
    if (!res.found) return { found: false, messages: [] };
    return {
      ...res,
      messages: res.messages.map((m) => ({ ...m, at: m.ts ? new Date(m.ts * 1000).toISOString() : null })),
    };
  }

  /** Is this number on WhatsApp, and what does the device know about it? */
  async resolve(number) {
    const num = normaliseNumber(number, this.defaultCountry);
    if (num.length < 8) throw new Error(`not a usable number: ${number}`);
    let wid = null;
    try {
      wid = await this.evaluate(async (num) => {
        const found = await window.require('WAWebQueryExistsJob').queryPhoneExists(num);
        if (!found) return null;
        const w = found.wid || found.jid || found;
        return w ? String(w._serialized || w) : null;
      }, num);
    } catch (e) {
      throw new Error(`could not resolve ${num}: ${e.message}`);
    }
    if (!wid) return { number: num, on_whatsapp: false, wid: null, chat: null };
    const chat = await this.evaluate((num) => {
      const CC = window.require('WAWebChatCollection').ChatCollection;
      for (const c of CC.getModelsArray()) {
        if (!c.id || c.id.server === 'g.us') continue;
        let pn = '';
        try {
          const ct = c.contact;
          if (ct && ct.phoneNumber) pn = String(ct.phoneNumber).split('@')[0];
          else if (c.id.server === 'c.us') pn = c.id.user || '';
        } catch (e) {}
        if (pn.replace(/\D/g, '') !== num) continue;
        let pushname = null, saved = false;
        try { pushname = (c.contact && (c.contact.pushname || c.contact.name)) || null; saved = !!(c.contact && c.contact.isMyContact); } catch (e) {}
        return { id: String(c.id._serialized || c.id), name: String(c.formattedTitle || c.name || ''),
                 pushname, saved_contact: saved, loaded_messages: c.msgs.getModelsArray().length };
      }
      return null;
    }, num);
    return { number: num, on_whatsapp: true, wid, chat };
  }

  /**
   * Ask the phone to push this chat's history to the device - what a human opening the
   * chat triggers. The store is best-effort, so call this before a read that came back
   * thinner than expected, then read again after a few seconds.
   */
  async requestHistory({ chatId, number } = {}) {
    const num = number ? normaliseNumber(number, this.defaultCountry) : '';
    if (!chatId && !num) throw new Error('requestHistory needs chatId or number');
    return this.evaluate(async (cid, num) => {
      const CC = window.require('WAWebChatCollection').ChatCollection;
      const PDO = window.require('WAWebSendNonMessageDataRequest');
      for (const c of CC.getModelsArray()) {
        if (!c.id) continue;
        const ser = String(c.id._serialized || c.id);
        let pn = '';
        try {
          const ct = c.contact;
          if (ct && ct.phoneNumber) pn = String(ct.phoneNumber).split('@')[0];
          else if (c.id.server === 'c.us') pn = c.id.user || '';
        } catch (e) {}
        if ((cid && ser === cid) || (num && pn.replace(/\D/g, '') === num)) {
          try { await PDO.sendPeerDataOperationRequest(3, { chatId: c.id }); return { requested: true, chat: ser }; }
          catch (e) { return { requested: false, error: String(e && e.message) }; }
        }
      }
      return { requested: false, error: 'chat not found on device' };
    }, chatId ?? '', num);
  }

  /**
   * Download one media message. Returns {data: base64, mimetype}. Ported from the
   * production extractor: the download-manager module has been renamed across builds, the
   * QPL argument must be a catch-all Proxy, and some records reject every named origin.
   */
  async fetchMedia({ chatId, number, messageId } = {}) {
    if (!messageId) throw new Error('fetchMedia needs messageId');
    const num = number ? normaliseNumber(number, this.defaultCountry) : '';
    const res = await this.evaluate(async (cid, num, mid) => {
      const CC = window.require('WAWebChatCollection').ChatCollection;
      let msg = null;
      for (const c of CC.getModelsArray()) {
        if (!c.id) continue;
        const ser = String(c.id._serialized || c.id);
        let pn = '';
        try {
          const ct = c.contact;
          if (ct && ct.phoneNumber) pn = String(ct.phoneNumber).split('@')[0];
          else if (c.id.server === 'c.us') pn = c.id.user || '';
        } catch (e) {}
        const target = (cid && ser === cid) || (num && pn.replace(/\D/g, '') === num) || (!cid && !num);
        if (!target) continue;
        msg = c.msgs.getModelsArray().find((m) => m.id && String(m.id._serialized || m.id) === mid) || null;
        if (msg) break;
      }
      if (!msg) return { err: 'message not found in the loaded store (try requestHistory first)' };
      if (!(msg.mediaKey || msg.directPath)) return { err: 'message carries no media' };
      let owner = null;
      for (const name of ['WAWebDownloadManager', 'WAWebMediaDownload', 'WAWebDownloadMedia']) {
        try {
          const mod = window.require(name);
          for (const o of [mod, mod && mod.default, mod && mod.downloadManager]) {
            if (o && typeof o.downloadAndMaybeDecrypt === 'function') { owner = o; break; }
          }
          if (owner) break;
        } catch (e) {}
      }
      if (!owner) return { err: 'no download-manager module on this build' };
      const qplStub = new Proxy({}, { get: () => () => ({}) });
      let lastErr = null;
      for (const origin of ['chat', 'mediaViewer', 'manualDownload', null]) {
        try {
          const req = { directPath: msg.directPath, encFilehash: msg.encFilehash, filehash: msg.filehash,
                        mediaKey: msg.mediaKey, mediaKeyTimestamp: msg.mediaKeyTimestamp, type: msg.type,
                        mimetype: msg.mimetype || 'image/jpeg', downloadQpl: qplStub,
                        signal: (new AbortController()).signal };
          if (origin) req.downloadOrigin = origin;
          const buf = await owner.downloadAndMaybeDecrypt(req);
          const bytes = new Uint8Array(buf);
          let bin = ''; const CH = 0x8000;
          for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
          return { data: btoa(bin), mimetype: msg.mimetype || 'image/jpeg', bytes: bytes.length };
        } catch (e) { lastErr = String((e && e.message) || e); }
      }
      return { err: lastErr || 'every download origin failed' };
    }, chatId ?? '', num, messageId);
    if (res.err) throw new Error(res.err);
    return res;
  }

  /**
   * Native transport for the guarded sender. Throws if the number is not on WhatsApp.
   *
   * The message model is built the way WhatsApp's own client (and the library that sends for
   * production every day) builds it: a real MsgKey, `from` in the same addressing form as the
   * chat (LID chats need the LID form of our own id, phone-number chats the phone form), and
   * the chat's ephemeral settings folded in. Hand the send action anything thinner and it
   * dies inside its own logging with "reading 'toLogString'".
   *
   * NOT retried. If the browser drops between the page sending and the result returning, this
   * throws an AMBIGUOUS error rather than sending a second time.
   */
  async sendText(number, text) {
    const num = normaliseNumber(number, this.defaultCountry);
    const body = String(text);
    if (!body.trim()) throw new Error('refusing to send an empty message');
    // evaluateOnce, never evaluate: a dropped connection here leaves us genuinely unable to
    // tell whether the message went out, and guessing "retry" means a resident is messaged
    // twice. Report the uncertainty instead.
    const res = await this.evaluateOnce(async (num, body) => {
      const found = await window.require('WAWebQueryExistsJob').queryPhoneExists(num);
      if (!found) return { err: num + ' is not on WhatsApp' };
      const chatWid = found.wid || found.jid || found;

      // findOrCreateLatestChat resolves to a wrapper, and the chat is its .chat property.
      const chat = window.require('WAWebChatCollection').ChatCollection.get(chatWid)
        || (await window.require('WAWebFindChatAction').findOrCreateLatestChat(chatWid))?.chat;
      if (!chat) return { err: 'could not open a chat for ' + num };

      const { getMaybeMeLidUser, getMaybeMePnUser } = window.require('WAWebUserPrefsMeUser');
      const from = chat.id.isLid() ? getMaybeMeLidUser() : getMaybeMePnUser();
      const MsgKey = window.require('WAWebMsgKey');
      const id = new MsgKey({ from, to: chat.id, id: await MsgKey.newId(), participant: undefined, selfDir: 'out' });

      let ephemeral = {};
      try {
        ephemeral = window.require('WAWebGetEphemeralFieldsMsgActionsUtils').getEphemeralFields(chat);
      } catch (e) { /* a chat without disappearing-message settings sends as a normal message */ }

      const msg = {
        id, ack: 0, body, from, to: chat.id, local: true, self: 'out',
        t: Math.floor(Date.now() / 1000), isNewMsg: true, type: 'chat', ...ephemeral,
      };
      await window.require('WAWebSendMsgChatAction').addAndSendMsgToChat(chat, msg);
      return { to: String(chat.id._serialized || chat.id), id: String(id._serialized || id) };
    }, num, body);
    if (res.err) throw new Error(res.err);
    return res;
  }
}

const QR_HTML = `<!DOCTYPE html><html><head><title>WhatsApp link QR</title>
<style>body{font-family:Arial;text-align:center;background:#111;color:#eee;padding-top:30px}
img{width:420px;height:420px;background:#fff;padding:16px;border-radius:8px}p{color:#8f8}</style>
</head><body><h2>Scan with the phone: WhatsApp &gt; Settings &gt; Linked devices &gt; Link a device</h2>
<img id="qr" src="qr.png"><p>Auto-refreshes every 5s (codes rotate ~20s). Leave this page open.</p>
<script>setInterval(()=>{document.getElementById('qr').src='qr.png?'+Date.now()},5000)</script>
</body></html>`;

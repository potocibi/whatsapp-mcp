import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Sender, normaliseRecipient, parseWindow, withinWindow } from '../src/sender.js';
import { commandTransport } from '../src/transport.js';

let dir;
let clock;          // mutable "now", so tests control time rather than wait for it
let sentCalls;      // what the fake transport was asked to do

const NOON = new Date('2026-09-02T12:00:00');

before(() => { dir = mkdtempSync(join(tmpdir(), 'wa-send-')); });
after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* lock */ } });

let n = 0;
function makeSender(overrides = {}) {
  clock = new Date(NOON);
  sentCalls = [];
  return new Sender({
    transport: async (to, text) => { sentCalls.push({ to, text }); return { ok: true }; },
    statePath: join(dir, `state-${++n}.json`),
    now: () => clock,
    ...overrides,
  });
}

describe('recipient normalisation', () => {
  test('reduces any formatting to digits, so one person is one recipient', () => {
    const forms = ['6591234567', '+65 9123 4567', '(65) 9123-4567', '65-9123-4567'];
    const all = new Set(forms.map(normaliseRecipient));
    assert.equal(all.size, 1, 'all of these are the same number and must dedupe together');
  });

  test('rejects something that cannot be a number', () => {
    assert.throws(() => normaliseRecipient('nobody'), /not a usable recipient/);
    assert.throws(() => normaliseRecipient(''), /not a usable recipient/);
    assert.throws(() => normaliseRecipient(null), /not a usable recipient/);
  });
});

describe('send window', () => {
  test('parses and rejects nonsense at construction time', () => {
    assert.deepEqual(parseWindow('09:00-21:00'), { startMin: 540, endMin: 1260 });
    assert.throws(() => parseWindow('9am to 9pm'), /unparseable send window/);
    assert.throws(() => parseWindow('25:00-26:00'), /impossible time/);
    assert.throws(() => makeSender({ window: 'whenever' }), /unparseable send window/);
  });

  test('is inclusive of the start and exclusive of the end', () => {
    assert.equal(withinWindow(new Date('2026-09-02T09:00:00'), '09:00-21:00'), true);
    assert.equal(withinWindow(new Date('2026-09-02T20:59:00'), '09:00-21:00'), true);
    assert.equal(withinWindow(new Date('2026-09-02T21:00:00'), '09:00-21:00'), false);
    assert.equal(withinWindow(new Date('2026-09-02T08:59:00'), '09:00-21:00'), false);
  });

  test('handles a window that wraps past midnight', () => {
    assert.equal(withinWindow(new Date('2026-09-02T23:30:00'), '22:00-06:00'), true);
    assert.equal(withinWindow(new Date('2026-09-02T02:00:00'), '22:00-06:00'), true);
    assert.equal(withinWindow(new Date('2026-09-02T12:00:00'), '22:00-06:00'), false);
  });
});

describe('the guard chain refuses', () => {
  test('an empty or oversized message', async () => {
    const s = makeSender();
    assert.match((await s.send('6591234567', '   ')).reason, /empty message/);
    assert.match((await s.send('6591234567', 'x'.repeat(5000))).reason, /over the 4096/);
    assert.equal(sentCalls.length, 0);
  });

  test('when the kill switch is set', async () => {
    const s = makeSender({ isPaused: () => true });
    const r = await s.send('6591234567', 'hello');
    assert.equal(r.sent, false);
    assert.match(r.reason, /kill switch/);
    assert.equal(sentCalls.length, 0);
  });

  test('a blocklisted recipient, in any formatting', async () => {
    const s = makeSender({ blocklist: () => new Set(['6591234567']) });
    const r = await s.send('+65 9123 4567', 'hello');
    assert.match(r.reason, /blocklist/);
    assert.equal(sentCalls.length, 0, 'formatting must not be a way around the blocklist');
  });

  test('outside the send window', async () => {
    const s = makeSender({ window: '09:00-21:00' });
    clock = new Date('2026-09-02T03:00:00');
    const r = await s.send('6591234567', 'hello');
    assert.match(r.reason, /outside the send window/);
    assert.equal(sentCalls.length, 0);
  });

  test('there is no send window unless one is configured', async () => {
    // Hours that suit one project are wrong for another, so by default any hour is allowed.
    const s = makeSender({ minGapSeconds: 0 });
    clock = new Date('2026-09-02T03:00:00');
    assert.equal((await s.send('6591234567', 'small hours')).sent, true);
    const st = s.status();
    assert.equal(st.window, null);
    assert.equal(st.within_window, true);
  });

  test('once the daily cap is reached', async () => {
    const s = makeSender({ maxPerDay: 2, minGapSeconds: 0 });
    for (let i = 0; i < 2; i++) {
      clock = new Date(NOON.getTime() + i * 60_000);
      assert.equal((await s.send('659123456' + i, `msg ${i}`)).sent, true);
    }
    clock = new Date(NOON.getTime() + 5 * 60_000);
    const r = await s.send('6599999999', 'one too many');
    assert.equal(r.sent, false);
    assert.match(r.reason, /daily cap reached \(2\/2\)/);
    assert.equal(sentCalls.length, 2);
  });

  test('there is no daily cap unless one is configured', async () => {
    // 30 a day is recommended, not imposed: the default must let a run go well past it.
    const s = makeSender({ minGapSeconds: 0 });
    for (let i = 0; i < 40; i++) {
      clock = new Date(NOON.getTime() + i * 60_000);
      const r = await s.send('65900000' + String(i).padStart(2, '0'), `msg ${i}`);
      assert.equal(r.sent, true, `send ${i} should be allowed: ${r.reason}`);
    }
    const st = s.status();
    assert.equal(st.sent_today, 40);
    assert.equal(st.max_per_day, null, 'no cap is reported as null, not a number');
    assert.equal(st.remaining_today, null);
  });

  test('a cap of 0 means no cap, not no sends', async () => {
    const s = makeSender({ maxPerDay: 0, minGapSeconds: 0 });
    assert.equal((await s.send('6591234567', 'hello')).sent, true);
    assert.equal(s.status().max_per_day, null);
  });

  test('a burst that ignores the minimum gap', async () => {
    const s = makeSender({ minGapSeconds: 30 });
    assert.equal((await s.send('6591111111', 'first')).sent, true);
    clock = new Date(NOON.getTime() + 5_000);
    const r = await s.send('6592222222', 'second');
    assert.match(r.reason, /minimum gap is 30s/);
  });

  test('the same message to the same person twice', async () => {
    const s = makeSender({ minGapSeconds: 0 });
    assert.equal((await s.send('6591234567', 'Your appointment is confirmed')).sent, true);
    clock = new Date(NOON.getTime() + 3600_000);
    const r = await s.send('+65 9123 4567', 'Your appointment is confirmed');
    assert.equal(r.sent, false);
    assert.match(r.reason, /identical message was sent/);
    assert.equal(sentCalls.length, 1);
  });

  test('but allows the same text to a different person', async () => {
    const s = makeSender({ minGapSeconds: 0 });
    await s.send('6591111111', 'same words');
    clock = new Date(NOON.getTime() + 1000);
    assert.equal((await s.send('6592222222', 'same words')).sent, true);
  });

  test('and allows a repeat once the duplicate window has passed', async () => {
    const s = makeSender({ minGapSeconds: 0, duplicateWindowHours: 1 });
    await s.send('6591234567', 'reminder');
    clock = new Date(NOON.getTime() + 2 * 3600_000);
    assert.equal((await s.send('6591234567', 'reminder')).sent, true);
  });
});

describe('quota accounting', () => {
  test('resets on a new local day', async () => {
    const s = makeSender({ maxPerDay: 1, minGapSeconds: 0 });
    assert.equal((await s.send('6591111111', 'day one')).sent, true);
    assert.equal((await s.send('6592222222', 'day one again')).sent, false);
    clock = new Date('2026-09-03T12:00:00');
    assert.equal(s.status().sent_today, 0, 'a new day starts with a fresh allowance');
    assert.equal((await s.send('6592222222', 'day two')).sent, true);
  });

  test('a transport failure is logged but does not consume quota', async () => {
    const s = makeSender({
      transport: async () => { throw new Error('phone offline'); },
      maxPerDay: 3,
    });
    const r = await s.send('6591234567', 'hello');
    assert.equal(r.sent, false);
    assert.match(r.error, /phone offline/);
    assert.equal(s.status().sent_today, 0, 'a broken transport must not burn the daily allowance');
  });

  test('survives a restart by reloading state from disk', async () => {
    const statePath = join(dir, 'shared-state.json');
    const opts = { statePath, now: () => clock, minGapSeconds: 0,
                   transport: async () => ({ ok: true }) };
    clock = new Date(NOON);
    const first = new Sender(opts);
    await first.send('6591234567', 'before restart');
    const second = new Sender(opts);          // as if the server had been restarted
    assert.equal(second.status().sent_today, 1);
    const r = await second.send('6591234567', 'before restart');
    assert.match(r.reason, /identical message/, 'dedup must outlive a restart');
  });

  test('a corrupt state file fails closed rather than resetting the caps silently', () => {
    const statePath = join(dir, 'corrupt.json');
    writeFileSync(statePath, '{not json', 'utf8');
    clock = new Date(NOON);
    const s = new Sender({ transport: async () => ({}), statePath, now: () => clock });
    assert.equal(s.status().sent_today, 0);   // usable, not crashed
  });

  test('records an audit trail without storing message text', async () => {
    const statePath = join(dir, 'audit.json');
    clock = new Date(NOON);
    const s = new Sender({ transport: async () => ({ ok: true }), statePath, now: () => clock });
    await s.send('6591234567', 'a very private sentence');
    const raw = readFileSync(statePath, 'utf8');
    assert.match(raw, /6591234567/, 'the recipient and time should be auditable');
    assert.doesNotMatch(raw, /very private sentence/,
      'message bodies must not be copied into the state file');
  });
});

describe('dry run', () => {
  test('reports the verdict without sending or counting', async () => {
    const s = makeSender();
    const r = await s.send('6591234567', 'hello', { dryRun: true });
    assert.equal(r.sent, false);
    assert.equal(r.dry_run, true);
    assert.equal(r.would_send, true);
    assert.equal(sentCalls.length, 0);
    assert.equal(s.status().sent_today, 0);
  });

  test('gives the same refusal the real call would', async () => {
    const s = makeSender({ isPaused: () => true });
    const dry = await s.send('6591234567', 'hello', { dryRun: true });
    const real = await s.send('6591234567', 'hello');
    assert.equal(dry.reason, real.reason, 'dry run must not diverge from the real path');
  });
});

describe('commandTransport', () => {
  test('passes recipient and body as env, never through a shell', async () => {
    // The body is deliberately hostile: if it were interpolated into a shell string this
    // would misbehave. Echoing it back through env proves it stayed data.
    const nasty = 'hi "there"; echo pwned; `whoami` $(id) \n second line';
    const t = commandTransport({
      command: process.execPath,
      args: ['-e', 'process.stdout.write(process.env.WA_TO + "|" + process.env.WA_MSG)'],
    });
    const res = await t('6591234567', nasty);
    assert.equal(res.exit_code, 0);
    assert.equal(res.stdout, `6591234567|${nasty}`.trim());
  });

  test('substitutes {to} and {text} for senders that want arguments', async () => {
    const t = commandTransport({
      command: process.execPath,
      args: ['-e', 'process.stdout.write(process.argv[1] + "/" + process.argv[2])', '{to}', '{text}'],
    });
    assert.equal((await t('659', 'hey')).stdout, '659/hey');
  });

  test('surfaces the command’s own error on a non-zero exit', async () => {
    const t = commandTransport({
      command: process.execPath,
      args: ['-e', 'console.error("number not on whatsapp"); process.exit(3)'],
    });
    await assert.rejects(() => t('659', 'x'), /exited 3: number not on whatsapp/);
  });

  test('times out rather than hanging forever', async () => {
    const t = commandTransport({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 60000)'],
      timeoutMs: 300,
    });
    await assert.rejects(() => t('659', 'x'), /timed out after 300ms/);
  });

  test('reports a command that does not exist', async () => {
    const t = commandTransport({ command: 'definitely-not-a-real-binary-xyz' });
    await assert.rejects(() => t('659', 'x'), /could not run send command/);
  });
});

describe('a transport that loses contact after handing the message over', () => {
  test('is not reported as a clean failure, and cannot be silently retried', async () => {
    // The dangerous case: the message may already have been delivered. Counting it protects
    // the recipient from a second copy; saying so protects the operator from assuming it failed.
    const s = makeSender({
      minGapSeconds: 0,
      transport: async () => {
        const e = new Error('WA_OUTCOME_UNKNOWN: the browser dropped mid-call');
        e.ambiguous = true;
        throw e;
      },
    });
    const r = await s.send('6591234567', 'did this go out?');
    assert.equal(r.sent, false);
    assert.equal(r.uncertain, true, 'an unknown outcome is not a known failure');
    assert.match(r.advice, /read the chat before sending again/);

    const st = s.status();
    assert.equal(st.sent_today, 1, 'it must count, so an automatic retry cannot repeat it');

    // And the duplicate guard now blocks the obvious retry.
    const retry = await s.send('6591234567', 'did this go out?');
    assert.equal(retry.sent, false);
    assert.match(retry.reason, /duplicate/i);
  });

  test('an ordinary transport failure still costs no quota', async () => {
    const s = makeSender({
      minGapSeconds: 0,
      transport: async () => { throw new Error('connection refused'); },
    });
    const r = await s.send('6591234567', 'nope');
    assert.equal(r.sent, false);
    assert.equal(r.uncertain, undefined, 'a plain failure is known to have failed');
    assert.equal(s.status().sent_today, 0);
  });
});

describe('the guard decides about the number the transport will dial', () => {
  // The blocklist used to be checked against digits only, while the live transport applied
  // WA_DEFAULT_COUNTRY afterwards. With 65 configured, a blocklist holding 6591234567 did not
  // match a request for 91234567 - the guard passed and the transport dialled the blocked
  // number. Both sides now normalise through one function.
  const blocked = () => new Set(['6591234567']);

  test('a blocklisted number cannot be reached in local format', async () => {
    const dialled = [];
    const s = makeSender({
      minGapSeconds: 0, defaultCountry: '65', blocklist: blocked,
      transport: async (to) => { dialled.push(to); return { ok: true }; },
    });
    for (const form of ['6591234567', '91234567', '+65 9123 4567', '9123 4567']) {
      const r = await s.send(form, 'hello');
      assert.equal(r.sent, false, `${form} reached a blocklisted number`);
      assert.match(r.reason, /blocklist/);
    }
    assert.deepEqual(dialled, [], 'the transport must never have been called');
  });

  test('a blocklist written in local format still blocks the international form', async () => {
    const s = makeSender({
      minGapSeconds: 0, defaultCountry: '65', blocklist: () => new Set(['6591234567']),
    });
    const r = await s.send('+6591234567', 'hello');
    assert.equal(r.sent, false);
  });

  test('without a country code the recipient is left alone', async () => {
    const s = makeSender({ minGapSeconds: 0, blocklist: blocked });
    // No WA_DEFAULT_COUNTRY: 91234567 is its own number, not a local form of the blocked one.
    assert.equal((await s.send('91234567', 'hi')).sent, true);
  });
});

describe('concurrent sends', () => {
  test('cannot slip past the guards by overlapping', async () => {
    // check() reads the state, the transport takes time, the result is recorded afterwards.
    // Overlapping calls used to pass against the same pre-send state, defeating the min gap.
    let calls = 0;
    const s = makeSender({
      minGapSeconds: 60,
      transport: async () => { await new Promise((r) => setTimeout(r, 30)); calls++; return { ok: true }; },
    });
    const results = await Promise.all([
      s.send('6591111111', 'a'), s.send('6592222222', 'b'), s.send('6593333333', 'c'),
    ]);
    assert.equal(results.filter((r) => r.sent).length, 1, 'only the first may go');
    assert.equal(calls, 1, 'the transport must not be called for the refused ones');
    assert.match(results.find((r) => !r.sent).reason, /gap/i);
  });

  test('one failing send does not wedge the queue behind it', async () => {
    let n = 0;
    const s = makeSender({
      minGapSeconds: 0,
      transport: async () => { if (++n === 1) throw new Error('boom'); return { ok: true }; },
    });
    const [first, second] = await Promise.all([s.send('6591111111', 'a'), s.send('6592222222', 'b')]);
    assert.equal(first.sent, false);
    assert.equal(second.sent, true, 'the queue must keep running after a failure');
  });
});

describe('normaliseRecipient stays a one-argument function', () => {
  test('because it gets passed straight to .map()', () => {
    // An optional second parameter silently collected the array index as a country code.
    const forms = ['6591234567', '+65 9123 4567', '(65) 9123-4567', '65-9123-4567'];
    assert.equal(new Set(forms.map(normaliseRecipient)).size, 1);
    assert.equal(normaliseRecipient.length, 1);
  });
});

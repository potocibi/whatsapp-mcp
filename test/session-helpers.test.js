// The live session cannot be exercised without a phone to scan a QR, so the pure pieces
// it is built from are tested directly: body normalisation, number extraction, the
// single-flight queue, and the state the Session exposes before anything is started.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  realBody, numberOfChat, normaliseNumber, SingleFlight, Session, STATES, defaultChromePath,
} from '../src/session.js';

describe('realBody', () => {
  test('prefers the caption over a thumbnail body', () => {
    assert.equal(realBody('Blk 552 #03-85', '/9j/4AAQSkZJRgABAQ...'), 'Blk 552 #03-85');
  });
  test('drops a base64 thumbnail when there is no caption', () => {
    // A media message with no caption must read as empty, not as a wall of JPEG bytes.
    assert.equal(realBody('', '/9j/4AAQSkZJRgABAQ'), '');
    assert.equal(realBody(null, 'iVBORw0KGgoAAAANSUhEUg'), '');
  });
  test('keeps an ordinary text body', () => {
    assert.equal(realBody(undefined, 'see you at 2pm'), 'see you at 2pm');
  });
});

describe('numberOfChat', () => {
  test('reads the number from contact.phoneNumber on an @lid chat', () => {
    assert.equal(numberOfChat({ id: { server: 'lid', user: '2020224606' },
                                contact: { phoneNumber: '6591234567@c.us' } }), '6591234567');
  });
  test('falls back to the @c.us id on a legacy chat', () => {
    assert.equal(numberOfChat({ id: { server: 'c.us', user: '6598765432' }, contact: {} }), '6598765432');
  });
  test('returns empty for a group or an unreadable chat', () => {
    assert.equal(numberOfChat({ id: { server: 'g.us', user: '123-456' } }), '');
    assert.equal(numberOfChat(null), '');
  });
});

describe('normaliseNumber', () => {
  test('strips formatting', () => {
    assert.equal(normaliseNumber('+65 9123-4567'), '6591234567');
  });
  test('prepends the default country to a bare local number only', () => {
    assert.equal(normaliseNumber('9123 4567', '65'), '6591234567');
    assert.equal(normaliseNumber('6591234567', '65'), '6591234567', 'must not double the code');
    assert.equal(normaliseNumber('447700900123', '65'), '447700900123', 'a full foreign number is left alone');
  });
});

describe('SingleFlight', () => {
  test('runs jobs strictly in order, one at a time', async () => {
    const q = new SingleFlight();
    const order = [];
    const job = (name, ms) => q.run(async () => {
      order.push(`${name}:start`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`${name}:end`);
      return name;
    });
    const results = await Promise.all([job('a', 30), job('b', 5), job('c', 1)]);
    assert.deepEqual(results, ['a', 'b', 'c']);
    assert.deepEqual(order, ['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end'],
      'a shorter later job must not overtake a longer earlier one');
  });

  test('a rejected job does not block the ones behind it', async () => {
    const q = new SingleFlight();
    await assert.rejects(() => q.run(async () => { throw new Error('boom'); }), /boom/);
    assert.equal(await q.run(async () => 'still works'), 'still works');
  });
});

describe('Session before it is started', () => {
  test('needs a data directory', () => {
    assert.throws(() => new Session({}), /dataDir/);
  });

  test('keeps the login in <dataDir>/session, where a LocalAuth profile would be', () => {
    // Chrome's profile IS the login, so this path is what survives a relink of the tool.
    const d = join(mkdtempSync(join(tmpdir(), 'wa-sess-')), 'profile');
    const s = new Session({ dataDir: d });
    assert.equal(s.profileDir, join(resolve(d), 'session'));
    assert.equal(s.qrPath, join(resolve(d), 'qr.png'));
  });

  test('reports not_started and no QR, and starts nothing on construction', () => {
    const s = new Session({ dataDir: join(mkdtempSync(join(tmpdir(), 'wa-sess-')), 'profile') });
    const st = s.status();
    assert.equal(st.state, STATES.NOT_STARTED);
    assert.equal(st.needs_qr, false);
    assert.equal(st.qr_png, null);
    assert.equal(st.phone, null);
    assert.equal(s.browser, null, 'constructing a Session must not launch a browser');
  });

  test('fails fast, and cleanly, when Chrome is not where it was told', async () => {
    const s = new Session({
      dataDir: join(mkdtempSync(join(tmpdir(), 'wa-sess-')), 'profile'),
      chromePath: 'C:/definitely/not/chrome.exe',
    });
    await assert.rejects(() => s.ensureReady(), /Chrome not found/);
    assert.equal(s.status().state, STATES.FAILED);
    assert.match(s.status().last_error, /WA_CHROME/);
  });
});

describe('defaultChromePath', () => {
  test('picks the first Chrome that exists on this platform', () => {
    const seen = [];
    const exists = (p) => { seen.push(p); return p.includes('chrome-stable'); };
    assert.equal(defaultChromePath('linux', exists), '/usr/bin/google-chrome-stable');
    assert.ok(seen.length > 1, 'it should have looked at more than one candidate');
  });

  test('falls back to the usual path so the error names something real', () => {
    assert.match(defaultChromePath('darwin', () => false), /Google Chrome/);
    assert.match(defaultChromePath('win32', () => false), /chrome\.exe$/);
  });

  test('an unknown platform still yields a path rather than undefined', () => {
    assert.ok(defaultChromePath('aix', () => false).length > 0);
  });
});

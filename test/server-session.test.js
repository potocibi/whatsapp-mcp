// The live layer over real MCP stdio, up to the point where a phone would be needed.
//
// What can be proved without scanning a QR: the live tools are absent unless WA_SESSION=1;
// enabling it launches nothing until a live tool is called; a fresh install gets its
// archive schema created; a misconfigured Chrome path is reported as a readable error and
// the server survives it; and sending-via-session is refused without a session.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, '..', 'src', 'server.js');

let dir;
before(() => { dir = mkdtempSync(join(tmpdir(), 'wa-mcp-live-')); });
after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* lock */ } });

async function connect(env) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--no-warnings', SERVER],
    env: { ...process.env, ...env },
  });
  const client = new Client({ name: 'test', version: '0' }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

function payload(res) {
  assert.ok(!res.isError, `tool errored: ${res.content?.[0]?.text}`);
  return JSON.parse(res.content[0].text);
}

/** Run the server to completion and capture its exit code + stderr (for refusal cases). */
function runServer(env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['--no-warnings', SERVER], { env: { ...process.env, ...env } });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => resolve({ code, err }));
    setTimeout(() => { try { p.kill(); } catch { /* done */ } }, 8000);
  });
}

describe('live layer is opt-in', () => {
  test('with WA_SESSION unset there are no live tools at all', async () => {
    const db = join(dir, 'plain.db');
    // A read-only server needs an existing archive; borrow the writer to make one.
    const { ArchiveWriter } = await import('../src/archive-writer.js');
    new ArchiveWriter(db).close();
    const c = await connect({ WA_ARCHIVE_DB: db });
    try {
      const names = (await c.listTools()).tools.map((t) => t.name);
      assert.ok(!names.some((n) => /live|session|resolve|sync|media|history/.test(n)),
        'no live tool may be advertised without WA_SESSION=1');
    } finally { await c.close(); }
  });

  test('sending via session is refused when there is no session', async () => {
    const db = join(dir, 'nosess.db');
    const { ArchiveWriter } = await import('../src/archive-writer.js');
    new ArchiveWriter(db).close();
    const { code, err } = await runServer({ WA_ARCHIVE_DB: db, WA_SEND_VIA_SESSION: '1' });
    assert.equal(code, 2);
    assert.match(err, /needs WA_SESSION=1/);
  });
});

describe('with WA_SESSION=1 and no phone', () => {
  let c;
  const db = () => join(dir, 'fresh', 'archive.db');
  const sessDir = () => join(dir, 'fresh', 'profile');

  before(async () => {
    c = await connect({
      WA_ARCHIVE_DB: db(),
      WA_SESSION: '1',
      WA_SESSION_DIR: sessDir(),
      WA_CHROME: 'C:/definitely/not/chrome.exe',     // must never launch a browser in CI
      WA_SEND_VIA_SESSION: '1',
    });
  });
  after(async () => { try { await c.close(); } catch { /* gone */ } });

  test('a fresh install gets its archive created, so the reader can open it', () => {
    assert.ok(existsSync(db()), 'archive.db should have been created on startup');
  });

  test('advertises the live tools and the session-backed send tools', async () => {
    const names = (await c.listTools()).tools.map((t) => t.name).sort();
    for (const n of ['wa_session_status', 'wa_live_chats', 'wa_live_read', 'wa_resolve',
                     'wa_request_history', 'wa_fetch_media', 'wa_sync', 'wa_send', 'wa_send_status']) {
      assert.ok(names.includes(n), `${n} missing`);
    }
  });

  test('status reports not_started and launches nothing', async () => {
    const s = payload(await c.callTool({ name: 'wa_session_status', arguments: {} }));
    assert.equal(s.state, 'not_started');
    assert.equal(s.needs_qr, false);
    assert.equal(s.qr_png, null);
  });

  test('send status names the live session as its transport', async () => {
    const s = payload(await c.callTool({ name: 'wa_send_status', arguments: {} }));
    assert.equal(s.via, 'live session');
  });

  test('a live call with a bad Chrome path fails readably and leaves the server alive', async () => {
    const res = await c.callTool({ name: 'wa_live_chats', arguments: {} });
    assert.ok(res.isError, 'should be an error result, not a hang or a crash');
    assert.match(res.content[0].text, /Chrome not found/);
    assert.match(res.content[0].text, /WA_CHROME/);
    const s = payload(await c.callTool({ name: 'wa_session_status', arguments: {} }));
    assert.equal(s.state, 'failed');
    assert.match(s.last_error, /Chrome not found/);
    // the archive half is untouched by the live failure
    const st = payload(await c.callTool({ name: 'wa_stats', arguments: {} }));
    assert.equal(st.messages, 0);
  });

  test('a send through the session reports the transport failure without consuming quota', async () => {
    const r = payload(await c.callTool({
      name: 'wa_send', arguments: { to: '6591234567', text: 'hello' },
    }));
    // The guard chain passes (fresh state, wide-open defaults are not guaranteed in the
    // window, so accept either a window refusal or a transport failure - but never a send).
    assert.equal(r.sent, false);
    if (r.allowed) assert.match(r.error, /Chrome not found/);
    const s = payload(await c.callTool({ name: 'wa_send_status', arguments: {} }));
    assert.equal(s.sent_today, 0, 'a failed transport must not burn quota');
  });
});

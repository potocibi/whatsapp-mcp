// End-to-end for the sending half, over real MCP stdio.
//
// The two things worth proving at this level: sending is genuinely opt-in (an unconfigured
// server advertises no way to send), and when it is enabled the guards actually reach the
// wire - a refusal must come back as a result the caller can read, not an exception, and
// nothing must reach the transport.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, '..', 'src', 'server.js');

let dir, dbPath, sinkPath, pausedPath, blockPath;

function seedDb() {
  dbPath = join(dir, 'send.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE messages (chat TEXT, unit TEXT, is_group INTEGER,
                                  from_me INTEGER, ts INTEGER, body TEXT, author TEXT)`);
  db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?,?)')
    .run('Zoe', 'Z-1', 0, 0, 1_756_000_000, 'hello', 'zoe');
  db.close();
}

/** A stand-in sender: appends "to|text" to a file so the test can see what was dispatched. */
function writeSinkScript() {
  const script = join(dir, 'sink.js');
  sinkPath = join(dir, 'sent.log');
  writeFileSync(script,
    `require('fs').appendFileSync(${JSON.stringify(sinkPath)},\n` +
    `  process.env.WA_TO + '|' + process.env.WA_MSG + '\\n');\n` +
    `process.stdout.write('queued');\n`, 'utf8');
  return script;
}

async function connect(env) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--no-warnings', SERVER],
    env: { ...process.env, WA_ARCHIVE_DB: dbPath, ...env },
  });
  const client = new Client({ name: 'test', version: '0' }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

function payload(res) {
  assert.ok(!res.isError, `tool errored: ${res.content?.[0]?.text}`);
  return JSON.parse(res.content[0].text);
}

const sentLines = () =>
  (existsSync(sinkPath) ? readFileSync(sinkPath, 'utf8') : '').split('\n').filter(Boolean);

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'wa-mcp-send-'));
  seedDb();
  pausedPath = join(dir, 'PAUSED');
  blockPath = join(dir, 'blocklist.txt');
  writeFileSync(blockPath, '# never contact these\n+65 9000 0000\n', 'utf8');
});
after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* lock */ } });

describe('sending is opt-in', () => {
  let client;
  before(async () => { client = await connect({}); });
  after(async () => { try { await client.close(); } catch { /* gone */ } });

  test('an unconfigured server advertises no way to send', async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(!names.some((n) => /send/.test(n)),
      'with no WA_SEND_COMMAND there must be no send tool at all');
    assert.deepEqual(names.sort(),
      ['wa_list_chats', 'wa_read_chat', 'wa_search', 'wa_stats', 'wa_unanswered']);
  });

  test('and calling one anyway is refused, not silently ignored', async () => {
    const res = await client.callTool({
      name: 'wa_send', arguments: { to: '6591234567', text: 'hi' },
    });
    assert.ok(res.isError);
    assert.match(res.content[0].text, /unknown tool/);
  });
});

describe('with sending enabled', () => {
  let client;
  before(async () => {
    client = await connect({
      WA_SEND_COMMAND: process.execPath,
      WA_SEND_ARGS: JSON.stringify([writeSinkScript()]),
      WA_SEND_STATE: join(dir, 'state.json'),
      WA_SEND_WINDOW: '00:00-23:59',      // so the suite does not depend on the clock
      WA_SEND_MIN_GAP_SEC: '0',
      WA_SEND_MAX_PER_DAY: '3',
      WA_SEND_PAUSED_FILE: pausedPath,
      WA_SEND_BLOCKLIST: blockPath,
    });
  });
  after(async () => { try { await client.close(); } catch { /* gone */ } });

  test('the send tools appear', async () => {
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.ok(names.includes('wa_send'));
    assert.ok(names.includes('wa_send_status'));
  });

  test('status reports the quota before anything is sent', async () => {
    const s = payload(await client.callTool({ name: 'wa_send_status', arguments: {} }));
    assert.equal(s.paused, false);
    assert.equal(s.within_window, true);
    assert.equal(s.max_per_day, 3);
    assert.equal(s.blocked_count, 1, 'the blocklist file should have been read');
  });

  test('a dry run reports the verdict and dispatches nothing', async () => {
    const r = payload(await client.callTool({
      name: 'wa_send', arguments: { to: '6591234567', text: 'dry', dry_run: true },
    }));
    assert.equal(r.sent, false);
    assert.equal(r.would_send, true);
    assert.equal(sentLines().length, 0);
  });

  test('a real send reaches the transport with the body intact', async () => {
    const r = payload(await client.callTool({
      name: 'wa_send', arguments: { to: '+65 9123 4567', text: 'line one\nline two' },
    }));
    assert.equal(r.sent, true);
    assert.equal(r.recipient, '6591234567', 'formatting should be normalised away');
    // The newline must survive the hop through the transport rather than being flattened.
    assert.equal(readFileSync(sinkPath, 'utf8'), '6591234567|line one\nline two\n');
  });

  test('the duplicate guard refuses a repeat, as a readable result not an exception', async () => {
    const before = sentLines().length;
    const r = payload(await client.callTool({
      name: 'wa_send', arguments: { to: '6591234567', text: 'line one\nline two' },
    }));
    assert.equal(r.sent, false);
    assert.match(r.reason, /identical message/);
    assert.equal(sentLines().length, before, 'nothing further should have been dispatched');
  });

  test('the blocklist is enforced through the tool', async () => {
    const r = payload(await client.callTool({
      name: 'wa_send', arguments: { to: '6590000000', text: 'should never arrive' },
    }));
    assert.equal(r.sent, false);
    assert.match(r.reason, /blocklist/);
    assert.doesNotMatch(readFileSync(sinkPath, 'utf8'), /should never arrive/);
  });

  test('the kill switch takes effect immediately, with no restart', async () => {
    writeFileSync(pausedPath, 'stop', 'utf8');
    const r = payload(await client.callTool({
      name: 'wa_send', arguments: { to: '6597777777', text: 'while paused' },
    }));
    assert.equal(r.sent, false);
    assert.match(r.reason, /kill switch/);
    unlinkSync(pausedPath);
    const after = payload(await client.callTool({ name: 'wa_send_status', arguments: {} }));
    assert.equal(after.paused, false, 'removing the file should re-enable sending immediately');
  });

  test('the daily cap stops a run', async () => {
    // One send has succeeded so far; the cap is 3.
    for (const t of ['second message', 'third message']) {
      const r = payload(await client.callTool({ name: 'wa_send', arguments: { to: '6598888888', text: t } }));
      assert.equal(r.sent, true, `expected "${t}" to go`);
    }
    const r = payload(await client.callTool({
      name: 'wa_send', arguments: { to: '6598888888', text: 'fourth message' },
    }));
    assert.equal(r.sent, false);
    assert.match(r.reason, /daily cap reached \(3\/3\)/);
  });
});

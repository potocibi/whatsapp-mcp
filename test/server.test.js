// End-to-end: spawn the server exactly as an MCP client would and speak the protocol to it
// over stdio. The archive tests cover the queries; this covers the wiring - tool discovery,
// argument plumbing, error reporting, and the promise that nothing here can write.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, '..', 'src', 'server.js');
const T0 = 1_756_000_000;

let dir, dbPath, client, transport;

function seed() {
  dbPath = join(dir, 'e2e.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE messages (chat TEXT, unit TEXT, is_group INTEGER,
                                  from_me INTEGER, ts INTEGER, body TEXT, author TEXT)`);
  const ins = db.prepare(`INSERT INTO messages VALUES (:chat,:unit,:is_group,:from_me,:ts,:body,:author)`);
  const rows = [
    { chat: 'Dana', unit: 'D-9', is_group: 0, from_me: 1, ts: T0, body: 'sending the quote now', author: 'me' },
    { chat: 'Dana', unit: 'D-9', is_group: 0, from_me: 0, ts: T0 + 90, body: 'got it, thanks', author: 'dana' },
    { chat: 'Dana', unit: 'D-9', is_group: 0, from_me: 1, ts: T0 + 120, body: 'welcome', author: 'me' },
    { chat: 'Eli', unit: 'E-4', is_group: 0, from_me: 0, ts: T0 + 500, body: 'any update?', author: 'eli' },
  ];
  for (const r of rows) ins.run(r);
  db.close();
}

/** Tool results come back as a JSON text block; unwrap it. */
function payload(res) {
  assert.ok(!res.isError, `tool errored: ${res.content?.[0]?.text}`);
  return JSON.parse(res.content[0].text);
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wa-mcp-e2e-'));
  seed();
  transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--no-warnings', SERVER],
    env: { ...process.env, WA_ARCHIVE_DB: dbPath },
  });
  client = new Client({ name: 'test', version: '0' }, { capabilities: {} });
  await client.connect(transport);
});

after(async () => {
  try { await client.close(); } catch { /* already gone */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows lock */ }
});

describe('MCP server over stdio', () => {
  test('advertises exactly the read tools when sending is not configured', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names,
      ['wa_list_chats', 'wa_read_chat', 'wa_search', 'wa_stats', 'wa_unanswered']);
    // Sending is opt-in via WA_SEND_COMMAND, which this fixture does not set. A default
    // install must therefore have no way to send or mutate anything.
    assert.ok(!names.some((n) => /send|write|delete|reply/.test(n)),
      'an unconfigured server must expose no way to send or mutate');
  });

  test('every tool declares a schema the client can validate against', async () => {
    const { tools } = await client.listTools();
    for (const t of tools) {
      assert.equal(t.inputSchema.type, 'object', `${t.name} has no object schema`);
      assert.ok(t.description && t.description.length > 40, `${t.name} needs a real description`);
    }
  });

  test('wa_stats reports the seeded archive', async () => {
    const s = payload(await client.callTool({ name: 'wa_stats', arguments: {} }));
    assert.equal(s.messages, 4);
    assert.equal(s.chats, 2);
    assert.equal(s.outbound, 2);
    assert.equal(s.inbound, 2);
  });

  test('wa_read_chat returns a conversation oldest-first', async () => {
    const r = payload(await client.callTool({
      name: 'wa_read_chat', arguments: { chat: 'Dana' },
    }));
    assert.equal(r.count, 3);
    assert.deepEqual(r.rows.map((m) => m.direction), ['out', 'in', 'out']);
    assert.match(r.rows[0].at, /^\d{4}-\d{2}-\d{2}T/, 'timestamps should be ISO, not raw epochs');
  });

  test('wa_search passes filters through', async () => {
    const all = payload(await client.callTool({
      name: 'wa_search', arguments: { text: 'the' },
    }));
    assert.equal(all.count, 1);
    const none = payload(await client.callTool({
      name: 'wa_search', arguments: { text: 'the', from_me: false },
    }));
    assert.equal(none.count, 0, 'direction filter did not reach the query');
  });

  test('wa_unanswered surfaces only the thread awaiting a reply', async () => {
    // Dana's thread ends with our own message, Eli's ends with theirs.
    const r = payload(await client.callTool({ name: 'wa_unanswered', arguments: {} }));
    assert.deepEqual(r.rows.map((m) => m.chat), ['Eli']);
  });

  test('a bad argument comes back as a readable error, not a crash', async () => {
    const res = await client.callTool({
      name: 'wa_read_chat', arguments: { chat: 'Dana', since: 'last tuesday' },
    });
    assert.ok(res.isError);
    assert.match(res.content[0].text, /unparseable date/);
    // and the server is still alive afterwards
    const s = payload(await client.callTool({ name: 'wa_stats', arguments: {} }));
    assert.equal(s.messages, 4);
  });

  test('an unaddressed read is refused with an explanation', async () => {
    const res = await client.callTool({ name: 'wa_read_chat', arguments: {} });
    assert.ok(res.isError);
    assert.match(res.content[0].text, /needs `chat_id`, `tag` or `chat`/);
  });
});

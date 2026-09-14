import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Archive, toEpochSeconds } from '../src/archive.js';

const DAY = 86400;
const T0 = 1_756_000_000; // a fixed, plausible epoch-seconds base

let dir;

/** Build a throwaway archive. `spec` lets a test choose different column names. */
function makeDb(name, spec, rows) {
  const path = join(dir, name);
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE ${spec.table} (${spec.ddl})`);
  const cols = spec.cols.join(', ');
  const holes = spec.cols.map((c) => `:${c}`).join(', ');
  const ins = db.prepare(`INSERT INTO ${spec.table} (${cols}) VALUES (${holes})`);
  for (const r of rows) ins.run(r);
  db.close();
  return path;
}

// The shape this project's own scraper writes.
const STANDARD = {
  table: 'messages',
  ddl: 'chat TEXT, unit TEXT, is_group INTEGER, from_me INTEGER, ts INTEGER, body TEXT, author TEXT',
  cols: ['chat', 'unit', 'is_group', 'from_me', 'ts', 'body', 'author'],
};

// A deliberately different archive: other column names, no tag, no group flag.
const FOREIGN = {
  table: 'log',
  ddl: 'conversation TEXT, outgoing INTEGER, timestamp INTEGER, text TEXT, sender TEXT',
  cols: ['conversation', 'outgoing', 'timestamp', 'text', 'sender'],
};

const ROWS = [
  { chat: 'Alice', unit: 'A-1', is_group: 0, from_me: 1, ts: T0, body: 'Hello there', author: 'me' },
  { chat: 'Alice', unit: 'A-1', is_group: 0, from_me: 0, ts: T0 + 60, body: 'Hi! 100% ready', author: 'alice' },
  { chat: 'Bob', unit: 'B-2', is_group: 0, from_me: 0, ts: T0 + DAY, body: 'are you free', author: 'bob' },
  { chat: 'Bob', unit: 'B-2', is_group: 0, from_me: 1, ts: T0 + DAY + 30, body: 'yes', author: 'me' },
  { chat: 'Carol', unit: 'C-3', is_group: 0, from_me: 0, ts: T0 + 2 * DAY, body: 'still waiting', author: 'carol' },
  { chat: 'Team', unit: null, is_group: 1, from_me: 0, ts: T0 + 3 * DAY, body: 'group chatter', author: 'dave' },
];

before(() => { dir = mkdtempSync(join(tmpdir(), 'wa-mcp-')); });
after(() => { rmSync(dir, { recursive: true, force: true }); });

describe('toEpochSeconds', () => {
  test('accepts ISO dates, ISO timestamps and epoch seconds', () => {
    assert.equal(toEpochSeconds('2026-08-31'), Date.parse('2026-08-31T00:00:00Z') / 1000);
    assert.equal(toEpochSeconds('2026-08-31T12:00:00Z'), Date.parse('2026-08-31T12:00:00Z') / 1000);
    assert.equal(toEpochSeconds(T0), T0);
    assert.equal(toEpochSeconds(String(T0)), T0);
    assert.equal(toEpochSeconds(null), null);
    assert.equal(toEpochSeconds(''), null);
  });

  test('rejects a small number rather than silently meaning 1970', () => {
    // The trap this guards: someone passes a year, or milliseconds/1000 gone wrong, and
    // every "since" filter silently matches everything.
    assert.throws(() => toEpochSeconds(2026), /plausible epoch/);
  });

  test('rejects unparseable input instead of filtering on NaN', () => {
    assert.throws(() => toEpochSeconds('last tuesday'), /unparseable/);
  });
});

describe('Archive on the standard schema', () => {
  let a;
  before(() => { a = new Archive(makeDb('std.db', STANDARD, ROWS)); });
  after(() => a.close());

  test('reports what the archive carries', () => {
    const c = a.capabilities();
    assert.equal(c.has_tag, true);
    assert.equal(c.has_groups, true);
    assert.equal(c.columns.tag, 'unit', 'the `unit` column should map onto the generic tag');
  });

  test('stats count inbound and outbound separately', () => {
    const s = a.stats();
    assert.equal(s.messages, 6);
    assert.equal(s.outbound, 2);
    assert.equal(s.inbound, 4);
    assert.equal(s.chats, 4);
  });

  test('listChats orders by most recent activity', () => {
    const chats = a.listChats({});
    assert.deepEqual(chats.map((c) => c.chat), ['Team', 'Carol', 'Bob', 'Alice']);
    assert.equal(chats.find((c) => c.chat === 'Alice').messages, 2);
  });

  test('listChats can filter to direct chats only', () => {
    assert.ok(a.listChats({ directOnly: true }).every((c) => !c.is_group));
  });

  test('readChat returns oldest-first for readability', () => {
    const msgs = a.readChat({ chat: 'Alice' });
    assert.deepEqual(msgs.map((m) => m.body), ['Hello there', 'Hi! 100% ready']);
    assert.deepEqual(msgs.map((m) => m.direction), ['out', 'in']);
  });

  test('readChat limit takes the NEWEST n, then presents them in order', () => {
    const msgs = a.readChat({ chat: 'Alice', limit: 1 });
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].body, 'Hi! 100% ready', 'a limit must not hand back the oldest');
  });

  test('readChat addresses a thread by tag', () => {
    assert.equal(a.readChat({ tag: 'B-2' }).length, 2);
  });

  test('readChat refuses an unaddressed call', () => {
    assert.throws(() => a.readChat({}), /needs `chat_id`, `tag` or `chat`/);
  });

  test('search escapes LIKE wildcards', () => {
    // '100%' must match one message, not every row.
    assert.equal(a.searchMessages({ text: '100%' }).length, 1);
    assert.equal(a.searchMessages({ text: '%' }).length, 1);
  });

  test('search filters by direction and time', () => {
    // 'e' appears in both outbound bodies ('Hello there', 'yes') and in three inbound ones.
    assert.equal(a.searchMessages({ text: 'e' }).length, 5);
    assert.equal(a.searchMessages({ text: 'e', fromMe: true }).length, 2);
    assert.equal(a.searchMessages({ text: 'e', fromMe: false }).length, 3);
    assert.equal(a.searchMessages({ text: 'group chatter', includeGroups: false }).length, 0);
    assert.equal(a.searchMessages({ text: 'still', since: T0 + DAY }).length, 1);
    assert.equal(a.searchMessages({ text: 'still', since: T0 + 5 * DAY }).length, 0);
  });

  test('unanswered finds threads awaiting a reply, and only those', () => {
    const open = a.unanswered({});
    // Alice and Carol both end on an inbound message; Bob was answered, and the group is
    // excluded by default. Newest first.
    assert.deepEqual(open.map((m) => m.chat), ['Carol', 'Alice']);
  });

  test('unanswered can include groups when asked', () => {
    assert.deepEqual(a.unanswered({ includeGroups: true }).map((m) => m.chat),
      ['Team', 'Carol', 'Alice']);
  });
});

describe('Archive on a foreign schema', () => {
  let a;
  before(() => {
    const rows = ROWS.map((r) => ({
      conversation: r.chat, outgoing: r.from_me,
      timestamp: r.ts, text: r.body, sender: r.author,
    }));
    a = new Archive(makeDb('foreign.db', FOREIGN, rows), { table: 'log' });
  });
  after(() => a.close());

  test('adapts to differently named columns', () => {
    const c = a.capabilities();
    assert.equal(c.columns.chat, 'conversation');
    assert.equal(c.columns.body, 'text');
    assert.equal(c.has_tag, false, 'this archive genuinely has no tag column');
  });

  test('still reads and searches', () => {
    assert.equal(a.readChat({ chat: 'Alice' }).length, 2);
    assert.equal(a.searchMessages({ text: 'waiting' })[0].chat, 'Carol');
  });

  test('treats every row as direct when there is no group flag', () => {
    assert.equal(a.stats().group_messages, 0);
    // With no group flag every row looks direct, so the group thread joins Alice and Carol.
    assert.equal(a.unanswered({}).length, 3);
  });

  test('explains itself when asked for a column it does not have', () => {
    assert.throws(() => a.readChat({ tag: 'A-1' }), /no tag column/);
    assert.throws(() => a.searchMessages({ text: 'x', tag: 'A-1' }), /no tag column/);
  });
});

describe('Archive construction', () => {
  test('rejects a table missing the required columns', () => {
    const path = makeDb('bad.db',
      { table: 'messages', ddl: 'chat TEXT, note TEXT', cols: ['chat', 'note'] },
      [{ chat: 'x', note: 'y' }]);
    assert.throws(() => new Archive(path), /missing required column/);
  });

  test('rejects a table that is not there', () => {
    const path = makeDb('empty.db', STANDARD, []);
    assert.throws(() => new Archive(path, { table: 'nope' }), /no table named/);
  });
});

describe('two chats that share a display name', () => {
  const build = () => {
    const p = join(dir, `same-name-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const db = new DatabaseSync(p);
    db.exec(`CREATE TABLE messages(chat TEXT, chat_id TEXT, msg_id TEXT, tag TEXT,
                                   is_group INTEGER, from_me INTEGER, ts INTEGER, body TEXT,
                                   author TEXT, type TEXT, has_media INTEGER, mimetype TEXT,
                                   dedup_key TEXT)`);
    const ins = db.prepare(`INSERT INTO messages (chat, chat_id, msg_id, is_group, from_me, ts, body)
                            VALUES (?,?,?,?,?,?,?)`);
    ins.run('Site Team', '111@g.us', 'a1', 1, 0, 1_756_000_000, 'block 531 done');
    ins.run('Site Team', '111@g.us', 'a2', 1, 0, 1_756_000_060, 'block 532 next');
    ins.run('Site Team', '222@g.us', 'b1', 1, 0, 1_756_000_030, 'different team entirely');
    db.close();
    return p;
  };

  test('are listed as two chats, not merged into one', () => {
    const a = new Archive(build());
    const chats = a.listChats({});
    a.close();
    assert.equal(chats.length, 2, 'same name, different groups - they are not one thread');
    assert.deepEqual(chats.map((c) => c.chat_id).sort(), ['111@g.us', '222@g.us']);
  });

  test('reading by name is refused rather than interleaving them', () => {
    const a = new Archive(build());
    assert.throws(() => a.readChat({ chat: 'Site Team' }), /matches 2 different chats/);
    const one = a.readChat({ chatId: '111@g.us' });
    a.close();
    assert.equal(one.length, 2, 'reading by id gets exactly one thread');
  });

  test('stats counts them separately', () => {
    const a = new Archive(build());
    assert.equal(a.stats().chats, 2);
    a.close();
  });
});

describe('an archive migrated from the pre-id schema', () => {
  // Every row predates chat_id, so every chat_id is NULL. SQL groups all NULLs together,
  // which collapsed every old chat into one nameless entry and counted zero distinct chats.
  const build = () => {
    const p = join(dir, `migrated-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const db = new DatabaseSync(p);
    db.exec(`CREATE TABLE messages(chat TEXT, chat_id TEXT, msg_id TEXT, tag TEXT,
                                   is_group INTEGER, from_me INTEGER, ts INTEGER, body TEXT,
                                   author TEXT, type TEXT, has_media INTEGER, mimetype TEXT,
                                   dedup_key TEXT)`);
    const ins = db.prepare('INSERT INTO messages (chat, ts, body, from_me) VALUES (?,?,?,?)');
    ins.run('Group A', 1_756_000_000, 'from A', 0);
    ins.run('Group A', 1_756_000_050, 'more from A', 0);
    ins.run('Group B', 1_756_000_100, 'from B', 0);
    db.close();
    return p;
  };

  test('still lists each old chat by name rather than one nameless blob', () => {
    const a = new Archive(build());
    const chats = a.listChats({});
    a.close();
    assert.equal(chats.length, 2, 'null ids must not merge every old chat into one');
    assert.deepEqual(chats.map((c) => c.chat).sort(), ['Group A', 'Group B']);
    assert.equal(chats.find((c) => c.chat === 'Group A').messages, 2);
  });

  test('counts them instead of reporting zero', () => {
    const a = new Archive(build());
    assert.equal(a.stats().chats, 2);
    a.close();
  });

  test('a chat half migrated and half re-scraped is still one chat', async () => {
    // Written through the writer, because healing the older rows is what keeps the thread
    // whole once only its recent messages come back with an id.
    const { ArchiveWriter } = await import('../src/archive-writer.js');
    const p = build();
    const w = new ArchiveWriter(p);
    w.upsert([{ chat: 'Group A', chat_id: 'a@g.us', msg_id: 'new1', is_group: true,
                from_me: false, ts: 1_756_000_200, body: 'newly scraped' }]);
    w.close();
    const a = new Archive(p);
    const groupA = a.listChats({}).filter((c) => c.chat === 'Group A');
    a.close();
    assert.equal(groupA.length, 1, 'one chat, however its rows were written');
    assert.equal(groupA[0].messages, 3, 'and it holds all of its messages');
  });
});

describe('mixed-state archives (the shapes a migration actually leaves behind)', () => {
  const FULL = `CREATE TABLE messages(chat TEXT, chat_id TEXT, msg_id TEXT, tag TEXT,
    is_group INTEGER, from_me INTEGER, ts INTEGER, body TEXT, author TEXT, type TEXT,
    has_media INTEGER, mimetype TEXT, dedup_key TEXT)`;
  const T = 1_756_000_000;
  let seq = 0;

  const make = (rows, sql = FULL) => {
    const p = join(dir, `mixed-${++seq}-${Date.now()}.db`);
    const db = new DatabaseSync(p);
    db.exec(sql);
    for (const r of rows) {
      const cols = Object.keys(r);
      db.prepare(`INSERT INTO messages (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
        .run(...cols.map((c) => r[c]));
    }
    db.close();
    return p;
  };

  test('a chat renamed part way through keeps its whole history', () => {
    // Its older messages are only findable under the name it used to have.
    const a = new Archive(make([
      { chat: 'Old Name', chat_id: 'x@g.us', msg_id: 'r1', ts: T, body: 'before', from_me: 0 },
      { chat: 'New Name', chat_id: 'x@g.us', msg_id: 'r2', ts: T + 100, body: 'after', from_me: 0 },
    ]));
    assert.equal(a.listChats({}).length, 1, 'one chat, two names');
    assert.equal(a.readChat({ chat: 'New Name' }).length, 2,
      'reading by the current name must not silently drop what came before the rename');
    assert.equal(a.readChat({ chatId: 'x@g.us' }).length, 2);
    a.close();
  });

  test('a chat only half of which carries an id is still one whole chat', () => {
    const a = new Archive(make([
      { chat: 'Site', ts: T, body: 'old, no id', from_me: 0 },
      { chat: 'Site', chat_id: 's@g.us', msg_id: 's2', ts: T + 100, body: 'new, has id', from_me: 0 },
    ]));
    assert.equal(a.listChats({}).length, 1, 'not two chats');
    assert.equal(a.readChat({ chatId: 's@g.us' }).length, 2,
      'reading by id must not drop the rows that predate the id');
    assert.equal(a.readChat({ chat: 'Site' }).length, 2);
    a.close();
  });

  test('flags a chat that absorbed older rows matched by name', () => {
    // The one assumption in the identity rules: an id-less row under a name known by exactly
    // one id belongs to that chat. Right after a migration, wrong if two chats shared a name
    // and one was never scraped. The flag makes that checkable rather than invisible.
    const a = new Archive(make([
      { chat: 'Site', ts: T, body: 'old, no id', from_me: 0 },
      { chat: 'Site', chat_id: 's@g.us', msg_id: 's2', ts: T + 100, body: 'new, has id', from_me: 0 },
    ]));
    const [chat] = a.listChats({});
    a.close();
    assert.equal(chat.includes_name_matched, true);
    assert.equal(chat.messages, 2);
  });

  test('the flag survives healing, which is what makes the assumption', async () => {
    // Healing gives id-less rows a chat_id on the strength of the name, overwriting the very
    // evidence that anything was assumed. Without recording it, the common case - a chat the
    // writer has already healed - would report clean.
    const { ArchiveWriter } = await import('../src/archive-writer.js');
    const p = make([
      { chat: 'Site', ts: T, body: 'old one', from_me: 0 },
      { chat: 'Site', ts: T + 10, body: 'old two', from_me: 0 },
    ]);
    const w = new ArchiveWriter(p);
    const r = w.upsert([{ chat: 'Site', chat_id: 's@g.us', msg_id: 'n1', ts: T + 100,
                          body: 'scraped', from_me: false }]);
    w.close();
    assert.equal(r.healed, 2, 'the older rows took the id from the name');

    const a = new Archive(p);
    const [chat] = a.listChats({});
    a.close();
    assert.equal(chat.messages, 3, 'one chat holding all of it');
    assert.equal(chat.includes_name_matched, true,
      'and it still says that two of those three were matched by name');
  });

  test('does not flag a chat whose messages all carry ids', () => {
    const a = new Archive(make([
      { chat: 'Site', chat_id: 's@g.us', msg_id: 's1', ts: T, body: 'one', from_me: 0 },
      { chat: 'Site', chat_id: 's@g.us', msg_id: 's2', ts: T + 10, body: 'two', from_me: 0 },
    ]));
    assert.equal(a.listChats({})[0].includes_name_matched, false, 'nothing was assumed here');
    a.close();
  });

  test('does not flag an archive that simply has no ids yet', () => {
    // Every chat is id-less, so nothing was matched INTO anything - the flag would be noise.
    const a = new Archive(make([
      { chat: 'Site', ts: T, body: 'one', from_me: 0 },
      { chat: 'Other', ts: T + 10, body: 'two', from_me: 0 },
    ]));
    assert.deepEqual(a.listChats({}).map((c) => c.includes_name_matched), [false, false]);
    a.close();
  });

  test('a tag on only some rows does not split the chat', () => {
    const a = new Archive(make([
      { chat: 'Unit chat', chat_id: 'u@g.us', msg_id: 'u1', tag: '551-02-95', ts: T, body: 'tagged', from_me: 0 },
      { chat: 'Unit chat', chat_id: 'u@g.us', msg_id: 'u2', ts: T + 10, body: 'untagged', from_me: 0 },
    ]));
    const chats = a.listChats({});
    assert.equal(chats.length, 1, 'a tag is an attribute of a chat, not part of which chat it is');
    assert.equal(chats[0].tag, '551-02-95', 'and the tag it does have is reported');
    a.close();
  });

  test('two chats that both know their ids are still refused by name', () => {
    // The genuinely ambiguous case must not be quietly merged.
    const a = new Archive(make([
      { chat: 'Team', chat_id: 't1@g.us', msg_id: 'a1', ts: T, body: 'one', from_me: 0 },
      { chat: 'Team', chat_id: 't2@g.us', msg_id: 'b1', ts: T + 10, body: 'two', from_me: 0 },
    ]));
    assert.throws(() => a.readChat({ chat: 'Team' }), /matches 2 different chats/);
    assert.equal(a.listChats({}).length, 2);
    a.close();
  });

  test('a name containing LIKE wildcards matches only itself', () => {
    const a = new Archive(make([
      { chat: '100% Done', chat_id: 'w1@g.us', msg_id: 'w1', ts: T, body: 'yes', from_me: 0 },
      { chat: '100X Done', chat_id: 'w2@g.us', msg_id: 'w2', ts: T + 10, body: 'no', from_me: 0 },
    ]));
    assert.equal(a.readChat({ chat: '100% Done' }).length, 1, 'the % must not act as a wildcard');
    a.close();
  });

  test('a generic `id` column is not mistaken for a WhatsApp message id', () => {
    // Handing a row number to wa_fetch_media fails in a confusing way; better to report none.
    const a = new Archive(make(
      [{ id: 1, chat: 'Foreign', ts: T, body: 'hello', from_me: 0 }],
      'CREATE TABLE messages(id INTEGER, chat TEXT, ts INTEGER, body TEXT, from_me INTEGER)'));
    assert.equal(a.capabilities().columns.msg_id, undefined);
    assert.equal(a.readChat({ chat: 'Foreign' })[0].msg_id, null);
    a.close();
  });

  test('reads stay fast on a large archive that has no ids yet', () => {
    // Resolving an id-less row to its chat costs a correlated subquery per row. Applied to a
    // freshly migrated archive - where every id is NULL and there is nothing to resolve - it
    // took minutes rather than milliseconds. It must only run where it can pay for itself.
    const rows = [];
    for (let c = 0; c < 300; c++) {
      for (let m = 0; m < 10; m++) {
        rows.push({ chat: `Chat ${c}`, ts: T + c * 1000 + m, body: `msg ${m}`, from_me: m % 2 });
      }
    }
    const a = new Archive(make(rows));
    const t0 = Date.now();
    const chats = a.listChats({ limit: 400 });
    const elapsed = Date.now() - t0;
    a.close();
    assert.equal(chats.length, 300);
    assert.ok(elapsed < 5000, `listChats over 3000 id-less rows took ${elapsed}ms`);
  });

  test('reads stay usable on a genuinely mixed archive', () => {
    const rows = [];
    for (let c = 0; c < 200; c++) {
      rows.push({ chat: `Chat ${c}`, ts: T + c * 100, body: 'old', from_me: 0 });
      rows.push({ chat: `Chat ${c}`, chat_id: `c${c}@g.us`, msg_id: `m${c}`,
                  ts: T + c * 100 + 1, body: 'new', from_me: 0 });
    }
    const a = new Archive(make(rows));
    const t0 = Date.now();
    const chats = a.listChats({ limit: 400 });
    const elapsed = Date.now() - t0;
    a.close();
    assert.equal(chats.length, 200, 'each chat counted once despite half its rows lacking ids');
    assert.ok(elapsed < 10_000, `listChats over a mixed archive took ${elapsed}ms`);
  });
});

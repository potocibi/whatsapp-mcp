import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ArchiveWriter, dedupKey } from '../src/archive-writer.js';
import { Archive } from '../src/archive.js';

let dir;
let n = 0;
const T0 = 1_756_000_000;
const fresh = () => join(dir, `w-${++n}.db`);

before(() => { dir = mkdtempSync(join(tmpdir(), 'wa-writer-')); });
after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* lock */ } });

describe('ArchiveWriter on an empty database', () => {
  test('creates the generic schema and the reader can immediately query it', () => {
    const p = fresh();
    const w = new ArchiveWriter(p);
    const r = w.upsert([
      { chat: 'Alice', tag: 'A-1', ts: T0, body: 'hello', from_me: true, author: 'me' },
      { chat: 'Alice', tag: 'A-1', ts: T0 + 5, body: 'hi back', from_me: false, author: 'alice' },
    ]);
    w.close();
    assert.equal(r.inserted, 2);
    assert.equal(r.skipped, 0);
    const a = new Archive(p);
    assert.equal(a.capabilities().columns.tag, 'tag');
    assert.deepEqual(a.readChat({ chat: 'Alice' }).map((m) => m.direction), ['out', 'in']);
    a.close();
  });

  test('a second sync of the same window inserts nothing', () => {
    const p = fresh();
    const rows = [
      { chat: 'Bob', ts: T0, body: 'one', from_me: false },
      { chat: 'Bob', ts: T0 + 1, body: 'two', from_me: true },
    ];
    const w = new ArchiveWriter(p);
    assert.equal(w.upsert(rows).inserted, 2);
    const again = w.upsert(rows);
    w.close();
    assert.equal(again.inserted, 0, 're-syncing must be idempotent');
    assert.equal(again.skipped, 2);
  });

  test('drops rows with no content, no timestamp or no chat, and says so', () => {
    const p = fresh();
    const w = new ArchiveWriter(p);
    const r = w.upsert([
      { chat: 'Carol', ts: T0, body: '   ', from_me: false },
      { chat: 'Carol', ts: 'soon', body: 'text', from_me: false },
      { chat: '', ts: T0, body: 'text', from_me: false },
      { chat: 'Carol', ts: T0 + 9, body: 'kept', from_me: false },
    ]);
    w.close();
    assert.equal(r.inserted, 1);
    assert.equal(r.skipped, 3);
  });


  test('keeps a photo that has no caption', () => {
    // Site evidence usually arrives as a bare image. The old writer dropped every one of
    // them because it keyed on a non-empty body.
    const p = fresh();
    const w = new ArchiveWriter(p);
    const r = w.upsert([
      { chat: 'Site', chat_id: '123@g.us', msg_id: 'false_123@g.us_AAA', ts: T0,
        body: '', from_me: false, has_media: true, type: 'image', mimetype: 'image/jpeg' },
      { chat: 'Site', chat_id: '123@g.us', msg_id: 'false_123@g.us_BBB', ts: T0,
        body: '', from_me: false, has_media: true, type: 'image', mimetype: 'image/jpeg' },
    ]);
    w.close();
    assert.equal(r.inserted, 2, 'two captionless photos in the same second are two messages, not one');
    assert.equal(r.media, 2);
  });

  test('preserves the ids that make an archived photo retrievable', () => {
    const p = fresh();
    const w = new ArchiveWriter(p);
    w.upsert([{ chat: 'Site', chat_id: '123@g.us', msg_id: 'false_123@g.us_CCC', ts: T0,
                body: 'roof', from_me: false, has_media: true, mimetype: 'image/jpeg' }]);
    w.close();
    const db = new DatabaseSync(p);
    const row = db.prepare('SELECT chat_id, msg_id, has_media, mimetype FROM messages').get();
    db.close();
    assert.equal(row.msg_id, 'false_123@g.us_CCC', 'without this, the image can never be fetched again');
    assert.equal(row.chat_id, '123@g.us');
    assert.equal(row.has_media, 1);
    assert.equal(row.mimetype, 'image/jpeg');
  });

  test('two groups sharing a display name stay separate', () => {
    const p = fresh();
    const w = new ArchiveWriter(p);
    const r = w.upsert([
      { chat: 'Site', chat_id: '111@g.us', msg_id: 'm1', ts: T0, body: 'ok', from_me: false },
      { chat: 'Site', chat_id: '222@g.us', msg_id: 'm2', ts: T0, body: 'ok', from_me: false },
    ]);
    w.close();
    assert.equal(r.inserted, 2, 'same name, same second, same text - but different groups');
  });

  test('the message id is what deduplicates, when there is one', () => {
    const p = fresh();
    const w = new ArchiveWriter(p);
    const row = { chat: 'Renamed later', chat_id: '111@g.us', msg_id: 'm9', ts: T0,
                  body: 'hello', from_me: false };
    assert.equal(w.upsert([row]).inserted, 1);
    // Same message, re-scraped after the group was renamed: still one row.
    assert.equal(w.upsert([{ ...row, chat: 'New name' }]).inserted, 0);
    w.close();
  });

  test('an older archive is migrated in place rather than rejected', () => {
    const p = fresh();
    const db = new DatabaseSync(p);
    db.exec(`CREATE TABLE messages(chat TEXT, tag TEXT, is_group INTEGER, from_me INTEGER,
                                   ts INTEGER, body TEXT, author TEXT,
                                   UNIQUE(chat, ts, from_me, body))`);
    db.prepare('INSERT INTO messages (chat, ts, body, from_me) VALUES (?,?,?,?)')
      .run('Old', T0, 'existing', 0);
    db.close();

    const w = new ArchiveWriter(p);
    assert.ok(w.added.includes('msg_id'), 'the new columns should be added to the old table');
    const r = w.upsert([{ chat: 'Old', chat_id: '9@c.us', msg_id: 'n1', ts: T0 + 1,
                          body: '', from_me: false, has_media: true }]);
    w.close();
    assert.equal(r.inserted, 1, 'a captionless photo lands in a migrated archive too');
    const check = new DatabaseSync(p);
    assert.equal(check.prepare('SELECT COUNT(*) c FROM messages').get().c, 2,
      'the pre-existing row must survive the migration');
    check.close();
  });

  test('dedupKey prefers the message id and falls back to content', () => {
    assert.equal(dedupKey({ msg_id: 'x', chat_id: 'c', ts: 1, from_me: false, body: 'b' }), 'id:x');
    const a = dedupKey({ chat_id: 'c', ts: 1, from_me: false, body: 'b' });
    const b = dedupKey({ chat_id: 'c', ts: 1, from_me: false, body: 'b' });
    const c = dedupKey({ chat_id: 'c', ts: 1, from_me: true, body: 'b' });
    assert.equal(a, b, 'the same message must key the same way twice');
    assert.notEqual(a, c, 'direction is part of identity');
  });


  test('an old archive loses its merging uniqueness rule, not just gains columns', () => {
    // The legacy UNIQUE(chat, ts, from_me, body) lives on the TABLE. Adding a better key
    // beside it changes nothing - two captionless photos still collide on the old one - so
    // the table has to be rebuilt without it.
    const p = fresh();
    const db = new DatabaseSync(p);
    db.exec(`CREATE TABLE messages(chat TEXT, tag TEXT, is_group INTEGER, from_me INTEGER,
                                   ts INTEGER, body TEXT, author TEXT,
                                   UNIQUE(chat, ts, from_me, body))`);
    db.prepare('INSERT INTO messages (chat, ts, body, from_me) VALUES (?,?,?,?)')
      .run('Site', T0, 'existing', 0);
    db.close();

    const w = new ArchiveWriter(p);
    assert.equal(w.rebuilt, true, 'the legacy constraint must actually be removed');
    const r = w.upsert([
      { chat: 'Site', chat_id: '1@g.us', msg_id: 'p1', ts: T0 + 60, body: '', from_me: false, has_media: true },
      { chat: 'Site', chat_id: '1@g.us', msg_id: 'p2', ts: T0 + 60, body: '', from_me: false, has_media: true },
    ]);
    w.close();
    assert.equal(r.inserted, 2, 'two distinct photos in the same second must both survive');

    const check = new DatabaseSync(p);
    assert.equal(check.prepare('SELECT COUNT(*) c FROM messages').get().c, 3,
      'and the pre-existing row must still be there');
    assert.match(check.prepare("SELECT sql FROM sqlite_master WHERE name='messages'").get().sql,
      /^(?!.*UNIQUE\s*\().*$/s, 'no table-level UNIQUE should remain');
    check.close();
  });

  test('migrating an old archive keeps re-syncing idempotent', () => {
    // Backfilled keys are what stop the rows that were already there from being inserted a
    // second time once the old constraint is gone.
    const p = fresh();
    const db = new DatabaseSync(p);
    db.exec(`CREATE TABLE messages(chat TEXT, tag TEXT, is_group INTEGER, from_me INTEGER,
                                   ts INTEGER, body TEXT, author TEXT,
                                   UNIQUE(chat, ts, from_me, body))`);
    db.prepare('INSERT INTO messages (chat, ts, body, from_me) VALUES (?,?,?,?)')
      .run('Bob', T0, 'hello', 0);
    db.close();

    const w = new ArchiveWriter(p);
    assert.equal(w.backfilled, 1, 'the pre-existing row needs a key');
    const again = w.upsert([{ chat: 'Bob', ts: T0, body: 'hello', from_me: false }]);
    w.close();
    assert.equal(again.inserted, 0, 're-scraping a message already in the archive must not double it');
  });


  test('re-scraping a migrated message adopts its id instead of duplicating it', () => {
    // The migrated row was keyed on the chat NAME, because it had no chat_id to key on. The
    // re-scrape has one, so its content key differs - look under both forms or the archive
    // gains a second copy of a message it already held.
    const p = fresh();
    const db = new DatabaseSync(p);
    db.exec(`CREATE TABLE messages(chat TEXT, tag TEXT, is_group INTEGER, from_me INTEGER,
                                   ts INTEGER, body TEXT, author TEXT,
                                   UNIQUE(chat, ts, from_me, body))`);
    db.prepare('INSERT INTO messages (chat, ts, body, from_me) VALUES (?,?,?,?)')
      .run('Group A', T0, 'from A', 0);
    db.close();

    const w = new ArchiveWriter(p);
    const scraped = { chat: 'Group A', chat_id: 'a@g.us', msg_id: 'm1', ts: T0,
                      body: 'from A', from_me: false, is_group: true };
    const first = w.upsert([scraped]);
    assert.equal(first.upgraded, 1, 'the row already there should take the id');
    assert.equal(first.inserted, 0, 'and must not be inserted again');
    assert.equal(w.upsert([scraped]).skipped, 1, 'a third pass changes nothing');
    w.close();

    const check = new DatabaseSync(p);
    assert.equal(check.prepare('SELECT COUNT(*) c FROM messages').get().c, 1);
    const row = check.prepare('SELECT msg_id, chat_id FROM messages').get();
    check.close();
    assert.equal(row.msg_id, 'm1', 'the surviving row carries the id, so its media is reachable');
    assert.equal(row.chat_id, 'a@g.us');
  });


  test('older rows of the same chat learn their id from a later sync', () => {
    // Only the messages the device still holds come back with an id. Without healing, the
    // rest of the chat keeps a null id and the thread reads as two chats forever.
    const p = fresh();
    const db = new DatabaseSync(p);
    db.exec(`CREATE TABLE messages(chat TEXT, tag TEXT, is_group INTEGER, from_me INTEGER,
                                   ts INTEGER, body TEXT, author TEXT,
                                   UNIQUE(chat, ts, from_me, body))`);
    const ins = db.prepare('INSERT INTO messages (chat, ts, body, from_me) VALUES (?,?,?,?)');
    ins.run('Group A', T0, 'old one', 0);
    ins.run('Group A', T0 + 10, 'old two', 0);
    ins.run('Group B', T0 + 20, 'elsewhere', 0);
    db.close();

    const w = new ArchiveWriter(p);
    const r = w.upsert([{ chat: 'Group A', chat_id: 'a@g.us', msg_id: 'n1', ts: T0 + 100,
                          body: 'fresh', from_me: false, is_group: true }]);
    w.close();
    assert.equal(r.healed, 2, "Group A's older rows should adopt its id");

    const check = new DatabaseSync(p);
    assert.equal(check.prepare("SELECT COUNT(*) c FROM messages WHERE chat_id = 'a@g.us'").get().c, 3);
    assert.equal(check.prepare("SELECT chat_id FROM messages WHERE chat = 'Group B'").get().chat_id, null,
      'a different chat must not be touched');
    check.close();
  });

  test('healing is skipped when a name means more than one chat', () => {
    const p = fresh();
    const db = new DatabaseSync(p);
    db.exec(`CREATE TABLE messages(chat TEXT, chat_id TEXT, msg_id TEXT, tag TEXT,
                                   is_group INTEGER, from_me INTEGER, ts INTEGER, body TEXT,
                                   author TEXT, type TEXT, has_media INTEGER, mimetype TEXT,
                                   dedup_key TEXT)`);
    // One row already ties this name to a different chat, and one old row has no id at all.
    db.prepare('INSERT INTO messages (chat, chat_id, msg_id, ts, body, from_me, dedup_key) VALUES (?,?,?,?,?,?,?)')
      .run('Site Team', '222@g.us', 'x1', T0, 'other group', 0, 'id:x1');
    db.prepare('INSERT INTO messages (chat, ts, body, from_me, dedup_key) VALUES (?,?,?,?,?)')
      .run('Site Team', T0 + 5, 'ambiguous old row', 0, 'c:old');
    db.close();

    const w = new ArchiveWriter(p);
    const r = w.upsert([{ chat: 'Site Team', chat_id: '111@g.us', msg_id: 'y1', ts: T0 + 10,
                          body: 'mine', from_me: false }]);
    w.close();
    assert.equal(r.healed, 0, 'guessing here would staple one group history onto another');
  });


  test('a re-scrape matches an old row whose stored body has since changed', () => {
    // An early scrape kept the base64 thumbnail of a photo where we now keep an empty caption.
    // The content key misses, so without a positional fallback the same photo lands twice.
    const p = fresh();
    const db = new DatabaseSync(p);
    db.exec(`CREATE TABLE messages(chat TEXT, tag TEXT, is_group INTEGER, from_me INTEGER,
                                   ts INTEGER, body TEXT, author TEXT,
                                   UNIQUE(chat, ts, from_me, body))`);
    db.prepare('INSERT INTO messages (chat, ts, body, from_me) VALUES (?,?,?,?)')
      .run('Site', T0, '/9j/4AAQSkZJRgABAQ', 0);
    db.close();

    const w = new ArchiveWriter(p);
    const r = w.upsert([{ chat: 'Site', chat_id: 'q@g.us', msg_id: 'q1', ts: T0, body: '',
                          from_me: false, has_media: true }]);
    w.close();
    assert.equal(r.upgraded, 1, 'the same message, recognised by where it sits in the chat');
    const check = new DatabaseSync(p);
    assert.equal(check.prepare('SELECT COUNT(*) c FROM messages').get().c, 1);
    check.close();
  });

  test('the positional fallback refuses to choose between two candidates', () => {
    const p = fresh();
    const db = new DatabaseSync(p);
    db.exec(`CREATE TABLE messages(chat TEXT, chat_id TEXT, msg_id TEXT, tag TEXT,
                                   is_group INTEGER, from_me INTEGER, ts INTEGER, body TEXT,
                                   author TEXT, type TEXT, has_media INTEGER, mimetype TEXT,
                                   dedup_key TEXT)`);
    const ins = db.prepare('INSERT INTO messages (chat, ts, body, from_me, dedup_key) VALUES (?,?,?,?,?)');
    ins.run('Site', T0, 'first', 0, 'c:one');
    ins.run('Site', T0, 'second', 0, 'c:two');
    db.close();

    const w = new ArchiveWriter(p);
    const r = w.upsert([{ chat: 'Site', chat_id: 'q@g.us', msg_id: 'q9', ts: T0, body: 'third',
                          from_me: false }]);
    w.close();
    assert.equal(r.upgraded, 0, 'two candidates at the same position is a guess, not a match');
    assert.equal(r.inserted, 1);
  });


  test('a hostile column type cannot smuggle statements into the rebuild', () => {
    // The rebuild repeats each column's declared type into a CREATE TABLE, and exec() runs a
    // whole script. The type is free text chosen by whoever made the table, so a foreign
    // archive - which this project explicitly accepts - could otherwise append its own DDL.
    const p = fresh();
    const db = new DatabaseSync(p);
    db.exec('CREATE TABLE messages(chat TEXT, ts INTEGER, body TEXT, from_me INTEGER, '
            + 'evil "TEXT); CREATE TABLE pwned(x); --", UNIQUE(chat, ts, from_me, body))');
    db.close();

    const w = new ArchiveWriter(p);
    w.close();
    const check = new DatabaseSync(p);
    const tables = check.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
      .map((r) => r.name);
    const type = check.prepare('PRAGMA table_info(messages)').all()
      .find((c) => c.name === 'evil').type;
    check.close();
    assert.ok(!tables.includes('pwned'), 'the injected statement must not have run');
    assert.equal(type, 'TEXT', 'an untrusted type is replaced rather than repeated');
  });

  test('a failure mid-batch rolls the whole batch back', () => {
    const p = fresh();
    const w = new ArchiveWriter(p);
    // Force a failure after the first row by handing the statement something unbindable.
    const bad = [{ chat: 'Dan', ts: T0, body: 'first', from_me: false },
                 { chat: 'Dan', ts: T0 + 1, body: 'second', from_me: false, author: {} }];
    assert.throws(() => w.upsert(bad));
    w.close();
    const a = new Archive(p);
    assert.equal(a.stats().messages, 0, 'no partial batch should survive a rollback');
    a.close();
  });
});

describe('ArchiveWriter on an existing archive with other column names', () => {
  test('writes the tag into a `unit` column when that is what exists', () => {
    const p = fresh();
    const db = new DatabaseSync(p);
    db.exec(`CREATE TABLE messages(chat TEXT, unit TEXT, is_group INTEGER, from_me INTEGER,
                                   ts INTEGER, body TEXT, author TEXT,
                                   UNIQUE(chat, ts, from_me, body))`);
    db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?,?)').run('Eve', 'E-5', 0, 0, T0, 'old', 'eve');
    db.close();

    const w = new ArchiveWriter(p);
    assert.equal(w.tagCol, 'unit');
    const r = w.upsert([
      { chat: 'Eve', tag: 'E-5', ts: T0, body: 'old', from_me: false },       // already there
      { chat: 'Eve', tag: 'E-5', ts: T0 + 3, body: 'new', from_me: true },
    ]);
    w.close();
    assert.equal(r.inserted, 1);
    assert.equal(r.skipped, 1);
    const a = new Archive(p);
    assert.equal(a.readChat({ tag: 'E-5' }).length, 2);
    a.close();
  });

  test('copes with a minimal table that has no tag, group or author columns', () => {
    const p = fresh();
    const db = new DatabaseSync(p);
    db.exec('CREATE TABLE messages(chat TEXT, ts INTEGER, body TEXT, from_me INTEGER)');
    db.close();
    const w = new ArchiveWriter(p);
    assert.equal(w.tagCol, null);
    const r = w.upsert([{ chat: 'Fay', ts: T0, body: 'x', from_me: false, tag: 'ignored', author: 'ignored' }]);
    w.close();
    assert.equal(r.inserted, 1);
  });

  test('refuses a table missing a required column rather than writing garbage', () => {
    const p = fresh();
    const db = new DatabaseSync(p);
    db.exec('CREATE TABLE messages(chat TEXT, note TEXT)');
    db.close();
    assert.throws(() => new ArchiveWriter(p), /lacks "ts"/);
  });
});

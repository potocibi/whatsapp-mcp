// Writes scraped messages into the SQLite archive that the read tools query.
//
// The reader (archive.js) is deliberately read-only; this is the one place that writes, and
// it does so with INSERT OR IGNORE against a `dedup_key`, so re-syncing the same window is
// idempotent - run it hourly and nothing doubles.
//
// Three things this schema is careful about, each of which was originally wrong:
//
//   1. A PHOTO WITH NO CAPTION IS STILL A MESSAGE. Site evidence usually arrives as a bare
//      image. Rows are kept when they carry media even though `body` is empty; only rows
//      with neither text nor media are dropped.
//
//   2. IDENTITY IS AN ID, NOT A NAME. `chat` holds the display name, which two groups can
//      share and which changes when someone renames a group. `chat_id` and `msg_id` are the
//      stable keys, and `msg_id` is what wa_fetch_media needs to pull a photo later - without
//      it, an archived image can never be retrieved again.
//
//   3. DEDUPLICATION MUST NOT MERGE DISTINCT MESSAGES. Keying on (chat, ts, from_me, body)
//      collapses two photos posted in the same second by the same person into one row, since
//      both have an empty body. `dedup_key` prefers the message id and only falls back to a
//      content composite when no id is available.
//
// Point 3 is why upgrading an older archive REBUILDS the table rather than only adding
// columns. The old `UNIQUE(chat, ts, from_me, body)` lives on the table itself, so adding a
// better key beside it changes nothing: INSERT OR IGNORE still silently drops the second of
// two captionless photos. SQLite cannot drop a table constraint, so the table is recreated
// without it and the rows are carried across.

import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const TAG_COLUMNS = ['tag', 'unit', 'label', 'ref'];

const CREATE = `
  CREATE TABLE IF NOT EXISTS messages(
    chat TEXT, chat_id TEXT, msg_id TEXT, tag TEXT, is_group INTEGER, from_me INTEGER,
    ts INTEGER, body TEXT, author TEXT, type TEXT, has_media INTEGER, mimetype TEXT,
    dedup_key TEXT, id_inferred INTEGER
  )`;

// Columns added to an archive created before they existed. Nullable and additive, so an older
// reader keeps working; SQLite cannot add a UNIQUE column, hence the separate index below.
const ADDABLE = [
  ['chat_id', 'TEXT'], ['msg_id', 'TEXT'], ['type', 'TEXT'],
  ['has_media', 'INTEGER'], ['mimetype', 'TEXT'], ['dedup_key', 'TEXT'],
  // Marks a chat_id this row was given by name rather than scraped with. Healing is the
  // one assumption in the identity rules, and it overwrites the evidence that it happened,
  // so the fact is recorded here instead of being inferable afterwards.
  ['id_inferred', 'INTEGER'],
];

const INDEXES = [
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_dedup ON messages(dedup_key)',
  'CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts)',
  'CREATE INDEX IF NOT EXISTS idx_messages_tag ON messages(tag, ts)',
  'CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id, ts)',
  // Resolving an id-less row to its chat's id looks up by name; without this it is a
  // full scan per row, which on a real archive does not finish.
  'CREATE INDEX IF NOT EXISTS idx_messages_chat_name ON messages(chat, chat_id)',
  'CREATE INDEX IF NOT EXISTS idx_messages_msg_id ON messages(msg_id)',
];

/**
 * A stable identity for one message. The WhatsApp message id is globally unique, so it wins
 * whenever the scraper could read one. Without it, fall back to the old content composite -
 * weaker, but it still stops an hourly re-sync from doubling plain text.
 */
export function dedupKey({ msg_id, chat_id, chat, ts, from_me, body }) {
  if (msg_id) return `id:${msg_id}`;
  return contentKey({ chat_id, chat, ts, from_me, body });
}

/**
 * The identity a row has when nothing knew its message id - which is what every row scraped
 * before the id columns existed was given during migration. Re-scraping such a message now
 * yields an id, and therefore a different key, so the archive would gain a second copy of a
 * message it already had. The writer looks a row up under this key first and upgrades it in
 * place instead.
 */
export function contentKey({ chat_id, chat, ts, from_me, body }) {
  const where = chat_id || chat || '';
  const digest = createHash('sha1').update(String(body ?? '')).digest('hex').slice(0, 16);
  return `c:${where}|${Math.floor(Number(ts))}|${from_me ? 1 : 0}|${digest}`;
}

export class ArchiveWriter {
  constructor(dbPath, { table = 'messages' } = {}) {
    if (table !== 'messages') {
      // The writer only knows one shape; refusing beats silently writing the wrong table.
      throw new Error('ArchiveWriter writes the `messages` table only');
    }
    this.dbPath = dbPath;
    this.db = new DatabaseSync(dbPath);
    this.added = [];
    this.rebuilt = false;
    this.backfilled = 0;
    try {
      let present = this.#columns();
      if (present.size === 0) {
        this.db.exec(CREATE);
        present = this.#columns();
        this.tagCol = 'tag';
      } else {
        for (const need of ['chat', 'ts', 'body', 'from_me']) {
          if (!present.has(need)) throw new Error(`existing messages table lacks "${need}"`);
        }
        this.tagCol = TAG_COLUMNS.find((c) => present.has(c)) ?? null;
        // Bring an older archive up to the current shape. Additive only.
        for (const [name, type] of ADDABLE) {
          if (present.has(name)) continue;
          try {
            this.db.exec(`ALTER TABLE messages ADD COLUMN ${name} ${type}`);
            present.add(name);
            this.added.push(name);
          } catch { /* a read-only or otherwise unalterable archive: write what fits */ }
        }
        // Then get rid of the old uniqueness rule, which would keep merging distinct rows.
        if (this.#hasLegacyUnique()) {
          try { this.#rebuildWithoutUnique(); this.rebuilt = true; }
          catch { /* could not rewrite it; the old constraint stays and so does its merging */ }
        }
      }
      this.has = (c) => present.has(c);
      // Existing rows need keys too, or a re-sync would insert them a second time now that
      // the old constraint is gone.
      if (this.has('dedup_key')) {
        try { this.backfilled = this.#backfillKeys(); } catch { /* not writable */ }
      }
      for (const sql of INDEXES) {
        // Each index is optional: a legacy archive may hold rows that violate the unique one,
        // and failing to build it must not stop the sync.
        try { this.db.exec(sql); } catch { /* index not available on this archive */ }
      }
    } catch (err) {
      try { this.db.close(); } catch { /* closing */ }
      throw err;
    }

    const cols = ['chat', 'ts', 'body', 'from_me'];
    if (this.tagCol) cols.push(this.tagCol);
    for (const c of ['is_group', 'author', 'chat_id', 'msg_id', 'type', 'has_media',
                     'mimetype', 'dedup_key']) {
      if (this.has(c)) cols.push(c);
    }
    this.cols = cols;
    this.insert = this.db.prepare(
      `INSERT OR IGNORE INTO messages (${cols.join(', ')}) VALUES (${cols.map((c) => ':' + c).join(', ')})`
    );
    if (this.has('dedup_key')) {
      this.byKey = this.db.prepare('SELECT rowid AS rid FROM messages WHERE dedup_key = :k');
      // Adopt the identity a re-scrape brings, on the row that is already there.
      const sets = ['dedup_key = :dedup_key'];
      for (const c of ['chat_id', 'msg_id', 'type', 'has_media', 'mimetype', 'is_group']) {
        if (this.has(c)) sets.push(`${c} = :${c}`);
      }
      this.upgrade = this.db.prepare(`UPDATE messages SET ${sets.join(', ')} WHERE rowid = :rid`);
      if (this.has('msg_id') && this.has('chat')) {
        this.byPosition = this.db.prepare(
          'SELECT rowid AS rid FROM messages WHERE chat = :c AND ts = :t AND from_me = :f '
          + 'AND msg_id IS NULL');
      }
    }
  }

  #columns() {
    return new Set(this.db.prepare('PRAGMA table_info(messages)').all().map((c) => c.name));
  }

  /** A table-level UNIQUE(...) from the old schema - the thing that merges distinct rows. */
  #hasLegacyUnique() {
    const row = this.db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'messages'"
    ).get();
    return !!(row && row.sql && /\bUNIQUE\s*\(/i.test(row.sql));
  }

  /**
   * Recreate the table with the same columns and none of the old constraints, carrying every
   * row across. SQLite has no DROP CONSTRAINT, so this is the only way to stop the legacy key
   * from silently discarding the second of two otherwise-identical messages.
   */
  #rebuildWithoutUnique() {
    const info = this.db.prepare('PRAGMA table_info(messages)').all();
    // The declared type is free text chosen by whoever created the table, and exec() runs a
    // whole script rather than one statement - so an unvalidated type could close the CREATE
    // and append statements of its own. Names are already checked; check types the same way.
    const defs = info.map((c) => `${quote(c.name)} ${safeType(c.type)}`.trim()).join(', ');
    const names = info.map((c) => quote(c.name)).join(', ');
    this.db.exec('BEGIN');
    try {
      this.db.exec(`CREATE TABLE messages__rebuild(${defs})`);
      this.db.exec(`INSERT INTO messages__rebuild (${names}) SELECT ${names} FROM messages`);
      this.db.exec('DROP TABLE messages');            // takes its indexes with it
      this.db.exec('ALTER TABLE messages__rebuild RENAME TO messages');
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      try { this.db.exec('DROP TABLE IF EXISTS messages__rebuild'); } catch { /* gone */ }
      throw e;
    }
  }

  /**
   * Teach the archive which chat its old rows belong to.
   *
   * Migrated rows have no chat_id, and only the messages the device still holds get one back
   * from a re-sync. That leaves a chat split down the middle - half its rows keyed by id, half
   * by name - and it reads as two chats forever. When a batch reveals the id behind a name,
   * apply it to that name's id-less rows.
   *
   * Skipped when the name is ambiguous, in either direction: two ids inside one batch, or a
   * name this archive already associates with a different chat. Guessing there would staple
   * one group's history onto another's.
   */
  #healChatIds(rows) {
    if (!this.has('chat_id')) return 0;
    const byName = new Map();
    for (const r of rows) {
      if (!r || !r.chat || !r.chat_id) continue;
      if (!byName.has(r.chat)) byName.set(r.chat, new Set());
      byName.get(r.chat).add(String(r.chat_id));
    }
    const known = this.db.prepare(
      'SELECT DISTINCT chat_id AS id FROM messages WHERE chat = :c AND chat_id IS NOT NULL');
    const heal = this.db.prepare(
      'UPDATE messages SET chat_id = :id'
      + (this.has('id_inferred') ? ', id_inferred = 1' : '')
      + ' WHERE chat = :c AND chat_id IS NULL');
    let healed = 0;
    for (const [name, ids] of byName) {
      if (ids.size !== 1) continue;
      const id = [...ids][0];
      if (known.all({ c: name }).some((row) => String(row.id) !== id)) continue;
      healed += heal.run({ id, c: name }).changes;
    }
    return healed;
  }

  /** Give pre-existing rows a dedup_key so a later sync recognises them. */
  #backfillKeys() {
    const rows = this.db.prepare(
      'SELECT rowid AS rid, chat, ts, body, from_me,'
      + (this.#columns().has('chat_id') ? ' chat_id,' : ' NULL AS chat_id,')
      + (this.#columns().has('msg_id') ? ' msg_id' : ' NULL AS msg_id')
      + ' FROM messages WHERE dedup_key IS NULL'
    ).all();
    if (!rows.length) return 0;
    const upd = this.db.prepare('UPDATE messages SET dedup_key = :k WHERE rowid = :rid');
    this.db.exec('BEGIN');
    try {
      for (const r of rows) upd.run({ k: dedupKey(r), rid: r.rid });
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return rows.length;
  }

  /**
   * @param {Array<{chat:string, ts:number, body:string, from_me:boolean, tag?:string|null,
   *                is_group?:boolean, author?:string|null, chat_id?:string|null,
   *                msg_id?:string|null, type?:string|null, has_media?:boolean,
   *                mimetype?:string|null}>} rows
   * @returns {{inserted:number, skipped:number, media:number, upgraded:number}}
   *   `upgraded` counts rows that were already present under a migration-era key and have
   *   now adopted the message id the re-scrape supplied; `healed` counts older rows of the
   *   same chat that learned their chat_id from this batch.
   */
  upsert(rows) {
    let inserted = 0;
    let skipped = 0;
    let media = 0;
    let upgraded = 0;
    let healed = 0;
    const run = () => {
      healed = this.#healChatIds(rows);
      for (const r of rows) {
        if (!r || !(r.chat || r.chat_id) || !Number.isFinite(Number(r.ts))) { skipped++; continue; }
        const body = String(r.body ?? '');
        const hasMedia = !!r.has_media;
        // An uncaptioned photo has no body and is still worth keeping; a row with neither
        // text nor media carries nothing at all.
        if (!body.trim() && !hasMedia) { skipped++; continue; }

        const params = {
          chat: String(r.chat ?? ''), ts: Math.floor(Number(r.ts)), body,
          from_me: r.from_me ? 1 : 0,
        };
        if (this.tagCol) params[this.tagCol] = r.tag ?? null;
        if (this.has('is_group')) params.is_group = r.is_group ? 1 : 0;
        if (this.has('author')) params.author = r.author ?? null;
        if (this.has('chat_id')) params.chat_id = r.chat_id ?? null;
        if (this.has('msg_id')) params.msg_id = r.msg_id ?? null;
        if (this.has('type')) params.type = r.type ?? null;
        if (this.has('has_media')) params.has_media = hasMedia ? 1 : 0;
        if (this.has('mimetype')) params.mimetype = r.mimetype ?? null;
        if (this.has('dedup_key')) {
          const idKey = dedupKey({ ...r, body });
          const cKey = contentKey({ ...r, body });
          params.dedup_key = idKey;
          // This message may already be here under the weaker key it was migrated with.
          // Give that row its id rather than adding a second copy of the same message.
          if (idKey !== cKey && this.upgrade) {
            // A row migrated from the old schema was keyed on the chat NAME, because it had
            // no chat_id to key on. The re-scrape does have one, so the id-less form of its
            // key differs from the stored one - look under both, or the message lands twice.
            let legacy = null;
            for (const k of new Set([cKey, contentKey({ ...r, chat_id: null, body })])) {
              legacy = this.byKey.get({ k });
              if (legacy) break;
            }
            // The stored body may no longer be what we would scrape today - an early scrape
            // kept the base64 thumbnail of a photo where we now keep an empty caption - so the
            // content key misses even though it is the same message. Fall back to the identity
            // the old schema actually enforced: one chat, one second, one direction. Only when
            // that picks out exactly one id-less row; two would be a guess.
            if (!legacy && this.byPosition) {
              const near = this.byPosition.all({
                c: String(r.chat ?? ''), t: Math.floor(Number(r.ts)), f: r.from_me ? 1 : 0,
              });
              if (near.length === 1) legacy = near[0];
            }
            if (legacy) {
              if (this.byKey.get({ k: idKey })) { skipped++; continue; }   // both forms present
              const set = { rid: legacy.rid, dedup_key: idKey };
              for (const c of ['chat_id', 'msg_id', 'type', 'has_media', 'mimetype', 'is_group']) {
                if (this.has(c)) set[c] = params[c] ?? null;
              }
              this.upgrade.run(set);
              upgraded++;
              continue;
            }
          }
        }

        const res = this.insert.run(params);
        if (res.changes > 0) { inserted++; if (hasMedia) media++; } else skipped++;
      }
    };
    // One transaction per batch: a 10k-row sync must not cost 10k fsyncs.
    this.db.exec('BEGIN');
    try { run(); this.db.exec('COMMIT'); }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return { inserted, skipped, media, upgraded, healed };
  }

  close() {
    this.db.close();
  }
}

/** A declared column type we are willing to repeat into DDL; anything else becomes TEXT. */
function safeType(type) {
  const t = String(type ?? '').trim();
  return /^[A-Za-z][A-Za-z0-9 ]*(\(\s*\d+\s*(,\s*\d+\s*)?\))?$/.test(t) ? t : 'TEXT';
}

/** Column names come from the archive itself, but quote them regardless. */
function quote(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`unsafe column name: ${name}`);
  return `"${name}"`;
}

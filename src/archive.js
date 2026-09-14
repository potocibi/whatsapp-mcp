// Query layer over a WhatsApp message archive held in SQLite.
//
// Free of any MCP types so it can be tested directly, and free of any assumption about
// whose archive it is. The only hard requirement is a table (default `messages`) with a
// timestamp, a body, and a direction flag. Everything else is optional and detected at
// startup, so an archive written by a different scraper still works:
//
//   required : ts (epoch seconds) | body | from_me
//   optional : chat, tag, author, is_group
//
// `tag` is a free-form thread label some scrapers attach to a chat - a ticket id, a
// customer number, a property reference. It is exposed when present and ignored when not.
//
// Opened READ-ONLY on purpose. This server answers questions about history; it never
// rewrites it, and it never touches a live WhatsApp session.

import { DatabaseSync } from 'node:sqlite';

const MAX_LIMIT = 500;

// Column aliases, so archives that spell things differently still line up. First match wins.
const COLUMN_ALIASES = {
  ts: ['ts', 'timestamp', 'time', 'sent_at', 'date'],
  body: ['body', 'text', 'message', 'content'],
  from_me: ['from_me', 'fromMe', 'is_outgoing', 'outgoing'],
  chat: ['chat', 'chat_name', 'conversation', 'thread'],
  tag: ['tag', 'unit', 'label', 'ref'],
  author: ['author', 'sender', 'from', 'participant'],
  is_group: ['is_group', 'isGroup', 'group'],
  // Identity and media. Absent from archives written before they existed, which is why
  // every one of these is optional and NULL-filled by #selectList.
  // NOT 'id': in a foreign archive that is usually a row number, and handing a row number
  // to wa_fetch_media as though it were a WhatsApp message id fails in a confusing way.
  msg_id: ['msg_id', 'message_id', 'wa_msg_id'],
  chat_id: ['chat_id', 'chatId', 'thread_id'],
  type: ['type', 'msg_type'],
  has_media: ['has_media', 'hasMedia'],
  mimetype: ['mimetype', 'mime_type', 'mime'],
  id_inferred: ['id_inferred'],
};

function clampLimit(limit, fallback = 50) {
  const n = Number.isFinite(limit) ? Math.floor(limit) : fallback;
  return Math.min(Math.max(n, 1), MAX_LIMIT);
}

/**
 * Accepts an ISO date ('2026-08-31'), a full ISO timestamp, or epoch seconds, and returns
 * epoch seconds. Callers pass dates far more often than epochs, so a bare number below the
 * year-2001 threshold is rejected rather than silently meaning 1970.
 */
export function toEpochSeconds(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number') {
    if (value < 1_000_000_000) throw new Error(`not a plausible epoch-seconds value: ${value}`);
    return Math.floor(value);
  }
  const s = String(value).trim();
  if (/^\d+$/.test(s)) return toEpochSeconds(Number(s));
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : s);
  if (Number.isNaN(ms)) throw new Error(`unparseable date: ${value}`);
  return Math.floor(ms / 1000);
}

/** Escape LIKE wildcards so a search for "100%" does not match every row. */
function likeTerm(text) {
  return `%${String(text).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export class Archive {
  constructor(dbPath, { table = 'messages' } = {}) {
    this.dbPath = dbPath;
    this.table = table;
    this.db = new DatabaseSync(dbPath, { readOnly: true });
    // Everything after the open must release the handle if it throws. Without this the
    // file stays locked for the life of the process - on Windows that also makes it
    // undeletable, which is how the tests caught it.
    try {
      const present = new Set(
        this.db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all().map((c) => c.name)
      );
      if (present.size === 0) throw new Error(`no table named "${table}" in ${dbPath}`);

      // Map each logical field to whichever real column this archive uses.
      this.col = {};
      for (const [logical, candidates] of Object.entries(COLUMN_ALIASES)) {
        this.col[logical] = candidates.find((c) => present.has(c)) ?? null;
      }
      // Resolving an id-less row to its chat's id costs a correlated subquery per row, which
      // is only affordable - and only necessary - when the archive actually holds both kinds.
      // A fully migrated archive (every id NULL) and a fully scraped one (none NULL) both key
      // on a single column. Checked once here rather than per query.
      this.mixedIds = false;
      const missing = ['ts', 'body', 'from_me'].filter((f) => !this.col[f]);
      if (missing.length) {
        throw new Error(
          `table "${table}" is missing required column(s): ${missing.join(', ')}. ` +
          `Found: ${[...present].join(', ')}`
        );
      }
      if (this.col.chat_id && this.col.chat) {
        const r = this.db.prepare(
          `SELECT SUM(CASE WHEN ${quoteIdent(this.col.chat_id)} IS NULL THEN 1 ELSE 0 END) AS nulls,
                  SUM(CASE WHEN ${quoteIdent(this.col.chat_id)} IS NOT NULL THEN 1 ELSE 0 END) AS ids
             FROM ${quoteIdent(table)}`).get();
        this.mixedIds = Number(r.nulls) > 0 && Number(r.ids) > 0;
        // Whether any row knows its chat id at all. When none does, the display name IS the
        // grouping key, so the query that hunts for a chat's latest name has nothing to find.
        this.hasAnyChatId = Number(r.ids) > 0;
      }
    } catch (err) {
      try { this.db.close(); } catch { /* already closing down */ }
      throw err;
    }
  }

  close() {
    this.db.close();
  }

  /** Which optional fields this archive actually carries - callers can adapt. */
  capabilities() {
    return {
      db_path: this.dbPath,
      table: this.table,
      columns: Object.fromEntries(Object.entries(this.col).filter(([, v]) => v)),
      has_tag: !!this.col.tag,
      has_groups: !!this.col.is_group,
      has_chat: !!this.col.chat,
      has_ids: !!this.col.msg_id,
      tracks_inferred_ids: !!this.col.id_inferred,
      has_media: !!this.col.has_media,
    };
  }

  /**
   * How a thread is identified in a GROUP BY or PARTITION BY.
   *
   * The id when there is one, the display name when there is not. A migrated archive holds
   * both kinds at once - rows scraped before the id columns existed have a NULL chat_id - and
   * SQL treats every NULL as the same group, so keying on the raw column would collapse every
   * old chat into one nameless entry and count them as zero distinct chats.
   */
  #chatKey(prefix = '') {
    const c = this.col;
    const q = (n) => (prefix ? `${prefix}.${quoteIdent(n)}` : quoteIdent(n));
    if (!c.chat_id || !c.chat) return q(c.chat_id || c.chat);
    // Not a mixed archive: one column answers for every row, no subquery needed.
    if (!this.mixedIds) return `IFNULL(${q(c.chat_id)}, ${q(c.chat)})`;
    // An id-less row is resolved to the id its own chat name is known by, so the half of a
    // chat that predates the id columns groups with the half that carries them. The HAVING
    // makes that resolution refuse to guess: a name known by two different ids yields NULL
    // and the row falls back to grouping under its name.
    // The outer reference MUST be qualified. Unqualified, `chat` inside the subquery binds to
    // the subquery's own table, so the condition reads m_r.chat = m_r.chat - always true - and
    // every id-less row in the archive adopts whichever single id happens to exist.
    const outerChat = prefix ? `${prefix}.${quoteIdent(c.chat)}`
                             : `${quoteIdent(this.table)}.${quoteIdent(c.chat)}`;
    const resolve = `(SELECT MIN(m_r.${quoteIdent(c.chat_id)})
                        FROM ${quoteIdent(this.table)} m_r
                       WHERE m_r.${quoteIdent(c.chat)} = ${outerChat}
                         AND m_r.${quoteIdent(c.chat_id)} IS NOT NULL
                      HAVING COUNT(DISTINCT m_r.${quoteIdent(c.chat_id)}) = 1)`;
    return `COALESCE(${q(c.chat_id)}, ${resolve}, ${q(c.chat)})`;
  }

  /** `SELECT` list that always yields the same logical shape, NULL-filling what is absent. */
  #selectList() {
    const c = this.col;
    return [
      c.chat ? `${quoteIdent(c.chat)} AS chat` : `NULL AS chat`,
      c.tag ? `${quoteIdent(c.tag)} AS tag` : `NULL AS tag`,
      c.is_group ? `${quoteIdent(c.is_group)} AS is_group` : `0 AS is_group`,
      c.author ? `${quoteIdent(c.author)} AS author` : `NULL AS author`,
      `${quoteIdent(c.from_me)} AS from_me`,
      `${quoteIdent(c.ts)} AS ts`,
      `${quoteIdent(c.body)} AS body`,
      c.msg_id ? `${quoteIdent(c.msg_id)} AS msg_id` : `NULL AS msg_id`,
      c.chat_id ? `${quoteIdent(c.chat_id)} AS chat_id` : `NULL AS chat_id`,
      c.type ? `${quoteIdent(c.type)} AS type` : `NULL AS type`,
      c.has_media ? `${quoteIdent(c.has_media)} AS has_media` : `0 AS has_media`,
      c.mimetype ? `${quoteIdent(c.mimetype)} AS mimetype` : `NULL AS mimetype`,
    ].join(', ');
  }

  #timeWhere(where, params, since, until) {
    const s = toEpochSeconds(since);
    const u = toEpochSeconds(until);
    if (s !== null) { where.push(`${quoteIdent(this.col.ts)} >= :since`); params.since = s; }
    if (u !== null) { where.push(`${quoteIdent(this.col.ts)} <= :until`); params.until = u; }
  }

  /** One row per chat: how much is held, and when it was last active. */
  listChats({ query, limit, groupsOnly, directOnly } = {}) {
    const c = this.col;
    if (!c.chat) throw new Error('this archive has no chat column, so chats cannot be listed');
    const where = [];
    const params = {};
    if (query) {
      const parts = [`${quoteIdent(c.chat)} LIKE :q ESCAPE '\\'`];
      if (c.tag) parts.push(`${quoteIdent(c.tag)} LIKE :q ESCAPE '\\'`);
      where.push(`(${parts.join(' OR ')})`);
      params.q = likeTerm(query);
    }
    if (c.is_group && groupsOnly) where.push(`${quoteIdent(c.is_group)} = 1`);
    if (c.is_group && directOnly) where.push(`${quoteIdent(c.is_group)} = 0`);
    params.limit = clampLimit(limit, 50);

    // Group by the chat ID when there is one, falling back to the display name for rows
    // that predate the id columns. Grouping by name alone merges two groups that share a
    // name; grouping by a NULL id merges every old chat into one.
    const key = this.#chatKey();
    // NULL and 0 are the same answer to "is this a group", and a migrated archive holds both
    // - rows written before the flag existed against rows written after. Left un-normalised
    // they split one chat into two entries.
    // Group by identity only. Whether a thread is a group is an attribute OF the chat, not
    // part of which chat it is, and a migrated archive holds rows written before the flag
    // existed (NULL) beside rows written after (0 or 1). Grouping on it splits one chat in two.
    const groupCols = [key];

    return this.db.prepare(`
      SELECT ${c.chat_id && this.hasAnyChatId
                ? `(SELECT m2.${quoteIdent(c.chat)} FROM ${quoteIdent(this.table)} m2
                     WHERE ${this.#chatKey('m2')} = ${this.#chatKey(quoteIdent(this.table))}
                     ORDER BY m2.${quoteIdent(c.ts)} DESC LIMIT 1) AS chat`
                : `${quoteIdent(c.chat)} AS chat`},
             ${c.chat_id ? `${quoteIdent(c.chat_id)} AS chat_id` : 'NULL AS chat_id'},
             ${c.tag ? `MAX(${quoteIdent(c.tag)}) AS tag` : 'NULL AS tag'},
             ${c.chat_id
               ? `((MAX(CASE WHEN ${quoteIdent(c.chat_id)} IS NOT NULL THEN 1 ELSE 0 END) = 1
                    AND MAX(CASE WHEN ${quoteIdent(c.chat_id)} IS NULL THEN 1 ELSE 0 END) = 1)
                   ${c.id_inferred
                     ? `OR MAX(IFNULL(${quoteIdent(c.id_inferred)}, 0)) = 1`
                     : ''})
                  AS name_matched`
               : '0 AS name_matched'},
             ${c.is_group ? `MAX(IFNULL(${quoteIdent(c.is_group)}, 0)) AS is_group` : '0 AS is_group'},
             COUNT(*) AS messages,
             SUM(CASE WHEN ${quoteIdent(c.from_me)} = 1 THEN 1 ELSE 0 END) AS outbound,
             MIN(${quoteIdent(c.ts)}) AS first_ts,
             MAX(${quoteIdent(c.ts)}) AS last_ts
      FROM ${quoteIdent(this.table)}
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      GROUP BY ${groupCols.join(', ')}
      ORDER BY last_ts DESC
      LIMIT :limit`).all(params).map(shapeChat);
  }

  /**
   * Messages for one chat, addressed by exact tag or by a chat-name substring.
   * Returned oldest-first - a conversation read backwards is unreadable - but selected
   * newest-first, so "the last 20" means the most recent 20, not the oldest 20.
   */
  /**
   * Every name this chat id has gone by. A group renamed half way through its history has
   * two, and its older messages are only findable under the old one.
   */
  #namesOf(chatId) {
    const c = this.col;
    if (!c.chat || !c.chat_id) return [];
    return this.db.prepare(
      `SELECT DISTINCT ${quoteIdent(c.chat)} AS name FROM ${quoteIdent(this.table)}
       WHERE ${quoteIdent(c.chat_id)} = :id AND ${quoteIdent(c.chat)} IS NOT NULL`
    ).all({ id: chatId }).map((r) => r.name);
  }

  /** The chat ids a display name refers to. More than one means the name is ambiguous. */
  #idsOf(name, exact = false) {
    const c = this.col;
    if (!c.chat || !c.chat_id) return [];
    const op = exact ? '=' : `LIKE :name ESCAPE '\\'`;
    const sql = `SELECT DISTINCT ${quoteIdent(c.chat_id)} AS id FROM ${quoteIdent(this.table)}
                 WHERE ${quoteIdent(c.chat)} ${exact ? '= :name' : op}
                   AND ${quoteIdent(c.chat_id)} IS NOT NULL`;
    return this.db.prepare(sql).all({ name: exact ? name : likeTerm(name) }).map((r) => r.id);
  }

  /**
   * Turn "the chat the caller means" into a condition that selects ALL of its messages.
   *
   * Neither column alone can do this on a migrated archive. Filtering by name loses the
   * messages sent before a rename; filtering by id loses the messages that predate the id
   * columns and were never re-scraped. So a thread is its id plus every name that belongs
   * only to it - and a name shared with another chat is left out rather than guessed at.
   */
  #threadWhere({ chat, chatId }) {
    const c = this.col;
    const params = {};
    if (!c.chat_id) {
      params.chat = likeTerm(chat);
      return { sql: `${quoteIdent(c.chat)} LIKE :chat ESCAPE '\\'`, params };
    }

    let ids = [];
    let names = [];
    if (chatId) {
      ids = [chatId];
      names = this.#namesOf(chatId);
    } else {
      ids = this.#idsOf(chat);
      if (ids.length > 1) {
        throw new Error(
          `"${chat}" matches ${ids.length} different chats (${ids.join(', ')}). `
          + 'Pass chat_id to read one of them.');
      }
      names = this.db.prepare(
        `SELECT DISTINCT ${quoteIdent(c.chat)} AS name FROM ${quoteIdent(this.table)}
         WHERE ${quoteIdent(c.chat)} LIKE :chat ESCAPE '\\'`
      ).all({ chat: likeTerm(chat) }).map((r) => r.name).filter((x) => x != null);
      if (ids.length === 1) names = names.concat(this.#namesOf(ids[0]));
    }

    // Only absorb id-less rows under names that mean this chat and nothing else.
    const safe = [...new Set(names)].filter((nm) => {
      const owners = this.#idsOf(nm, true);
      return owners.length === 0 || (owners.length === 1 && owners[0] === ids[0]);
    });

    const parts = [];
    if (ids.length) {
      ids.forEach((id, i) => { params[`id${i}`] = id; });
      parts.push(`${quoteIdent(c.chat_id)} IN (${ids.map((_, i) => ':id' + i).join(', ')})`);
    }
    if (safe.length) {
      safe.forEach((nm, i) => { params[`nm${i}`] = nm; });
      parts.push(`(${quoteIdent(c.chat_id)} IS NULL AND `
                 + `${quoteIdent(c.chat)} IN (${safe.map((_, i) => ':nm' + i).join(', ')}))`);
    }
    if (!parts.length) {   // nothing known by that name or id
      params.chat = likeTerm(chat ?? '');
      return { sql: `${quoteIdent(c.chat)} LIKE :chat ESCAPE '\\'`, params };
    }
    return { sql: `(${parts.join(' OR ')})`, params };
  }

  readChat({ tag, chat, chatId, limit, since, until } = {}) {
    if (!tag && !chat && !chatId) throw new Error('read_chat needs `chat_id`, `tag` or `chat`');
    if (tag && !this.col.tag) throw new Error('this archive has no tag column; use `chat`');
    if (chat && !this.col.chat) throw new Error('this archive has no chat column; use `tag`');
    if (chatId && !this.col.chat_id) throw new Error('this archive has no chat_id column');
    const where = [];
    const params = {};
    if (tag) { where.push(`${quoteIdent(this.col.tag)} = :tag`); params.tag = tag; }
    if (chat || chatId) {
      const t = this.#threadWhere({ chat, chatId });
      where.push(t.sql);
      Object.assign(params, t.params);
    }
    this.#timeWhere(where, params, since, until);
    params.limit = clampLimit(limit, 50);
    const rows = this.db.prepare(`
      SELECT ${this.#selectList()}
      FROM ${quoteIdent(this.table)}
      WHERE ${where.join(' AND ')}
      ORDER BY ${quoteIdent(this.col.ts)} DESC
      LIMIT :limit`).all(params);
    return rows.reverse().map(shapeMessage);
  }

  /** Substring search across message bodies. */
  searchMessages({ text, tag, since, until, fromMe, limit, includeGroups = true } = {}) {
    if (!text) throw new Error('search_messages needs `text`');
    const c = this.col;
    const where = [`${quoteIdent(c.body)} LIKE :text ESCAPE '\\'`];
    const params = { text: likeTerm(text) };
    if (tag) {
      if (!c.tag) throw new Error('this archive has no tag column');
      where.push(`${quoteIdent(c.tag)} = :tag`);
      params.tag = tag;
    }
    if (c.is_group && !includeGroups) where.push(`${quoteIdent(c.is_group)} = 0`);
    if (fromMe === true) where.push(`${quoteIdent(c.from_me)} = 1`);
    if (fromMe === false) where.push(`${quoteIdent(c.from_me)} = 0`);
    this.#timeWhere(where, params, since, until);
    params.limit = clampLimit(limit, 50);
    return this.db.prepare(`
      SELECT ${this.#selectList()}
      FROM ${quoteIdent(this.table)}
      WHERE ${where.join(' AND ')}
      ORDER BY ${quoteIdent(c.ts)} DESC
      LIMIT :limit`).all(params).map(shapeMessage);
  }

  /**
   * Chats whose most recent message came from the other party - someone is waiting on a
   * reply. Groups are excluded by default: nobody owes a group an answer.
   */
  unanswered({ since, limit, includeGroups = false } = {}) {
    const c = this.col;
    if (!c.chat) throw new Error('this archive has no chat column, so threads cannot be grouped');
    const where = [];
    const params = {};
    if (c.is_group && !includeGroups) where.push(`${quoteIdent(c.is_group)} = 0`);
    this.#timeWhere(where, params, since, undefined);
    params.limit = clampLimit(limit, 50);
    return this.db.prepare(`
      WITH ranked AS (
        SELECT ${this.#selectList()},
               ROW_NUMBER() OVER (PARTITION BY ${this.#chatKey()}
                                  ORDER BY ${quoteIdent(c.ts)} DESC) AS rn
        FROM ${quoteIdent(this.table)}
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      )
      SELECT chat, tag, is_group, author, from_me, ts, body,
             msg_id, chat_id, type, has_media, mimetype
      FROM ranked
      WHERE rn = 1 AND from_me = 0
      ORDER BY ts DESC
      LIMIT :limit`).all(params).map(shapeMessage);
  }

  /** Coverage of the archive - worth checking before trusting an absence of results. */
  stats() {
    const c = this.col;
    const row = this.db.prepare(`
      SELECT COUNT(*) AS messages,
             ${c.chat_id || c.chat ? `COUNT(DISTINCT ${this.#chatKey()})` : 'NULL'} AS chats,
             ${c.tag ? `COUNT(DISTINCT ${quoteIdent(c.tag)})` : 'NULL'} AS tags,
             ${c.is_group ? `SUM(CASE WHEN ${quoteIdent(c.is_group)} = 1 THEN 1 ELSE 0 END)` : '0'} AS group_messages,
             SUM(CASE WHEN ${quoteIdent(c.from_me)} = 1 THEN 1 ELSE 0 END) AS outbound,
             MIN(${quoteIdent(c.ts)}) AS first_ts,
             MAX(${quoteIdent(c.ts)}) AS last_ts
      FROM ${quoteIdent(this.table)}`).get();
    return {
      ...this.capabilities(),
      messages: row.messages,
      chats: row.chats,
      tags: row.tags,
      group_messages: row.group_messages,
      outbound: row.outbound,
      inbound: row.messages - row.outbound,
      first: isoOrNull(row.first_ts),
      last: isoOrNull(row.last_ts),
    };
  }
}

/** Identifiers come from config, not from tool arguments, but quote them regardless. */
function quoteIdent(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`unsafe identifier: ${name}`);
  return `"${name}"`;
}

function isoOrNull(ts) {
  return ts ? new Date(Number(ts) * 1000).toISOString() : null;
}

function shapeChat(r) {
  return {
    chat: r.chat,
    chat_id: r.chat_id ?? null,
    // True when some of this chat's older messages were matched to it by name rather than
    // by an id of their own - either rows still waiting for one, or rows the writer has since
    // given one on the strength of the name. Almost always the pre-id half of the same chat;
    // the exception is a different chat that shared the name and was never scraped. Surfaced
    // rather than hidden, so the assumption is checkable instead of invisible.
    includes_name_matched: !!r.name_matched,
    tag: r.tag ?? null,
    is_group: !!r.is_group,
    messages: r.messages,
    outbound: r.outbound,
    inbound: r.messages - r.outbound,
    first: isoOrNull(r.first_ts),
    last: isoOrNull(r.last_ts),
  };
}

function shapeMessage(r) {
  return {
    chat: r.chat ?? null,
    tag: r.tag ?? null,
    is_group: !!r.is_group,
    direction: r.from_me ? 'out' : 'in',
    at: isoOrNull(r.ts),
    ts: Number(r.ts),
    author: r.author ?? null,
    body: r.body ?? '',
    // Present only when the archive carries them. msg_id is what wa_fetch_media needs, so an
    // archived photo stays retrievable instead of being a row that merely mentions one.
    msg_id: r.msg_id ?? null,
    chat_id: r.chat_id ?? null,
    type: r.type ?? null,
    has_media: !!r.has_media,
    mimetype: r.mimetype ?? null,
  };
}

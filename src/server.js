#!/usr/bin/env node
// MCP server for WhatsApp: a typed reader over a message archive, an optional live scraper
// that owns its own WhatsApp Web login, and an optional guarded sender.
//
// Configuration (environment):
//
//   WA_ARCHIVE_DB        SQLite archive the read tools query and the scraper writes (required)
//   WA_ARCHIVE_TABLE     table name (default: messages)
//
//   WA_SESSION=1         enable the live layer. The server links ITS OWN device under
//                        WA_SESSION_DIR (default <db dir>/.wa-session); first run writes a
//                        QR to <dir>/qr.png for you to scan. Off by default: with it unset,
//                        no browser is ever launched and no live tool is advertised.
//   WA_SESSION_DIR       login profile directory
//   WA_CHROME            Chrome executable (default: the first one found for this platform)
//   WA_HEADLESS=0        show the browser window
//   WA_DEFAULT_COUNTRY   digits prepended to bare local numbers, e.g. 65
//
//   WA_SEND_COMMAND      external command that performs a send (see transport.js), OR
//   WA_SEND_VIA_SESSION=1  send natively through the live session (needs WA_SESSION=1).
//                        Either one enables the send tools; neither means read-only.
//   WA_SEND_ARGS, WA_SEND_STATE, WA_SEND_MAX_PER_DAY, WA_SEND_WINDOW, WA_SEND_MIN_GAP_SEC,
//   WA_SEND_DUP_HOURS, WA_SEND_PAUSED_FILE, WA_SEND_BLOCKLIST   - see sender.js
//
// Three things are true of every configuration: the archive reader is read-only; the live
// layer is a linked device whose store is best-effort and says so; and every send crosses
// the same guard chain, because a bare send(to, text) is one confident mistake away from
// messaging a stranger at 3am, forty times, twice.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

import { normaliseNumber } from './number.js';

import { Archive } from './archive.js';
import { ArchiveWriter } from './archive-writer.js';
import { Sender } from './sender.js';
import { Session } from './session.js';
import { commandTransport } from './transport.js';

const DB_PATH = process.env.WA_ARCHIVE_DB;
const TABLE = process.env.WA_ARCHIVE_TABLE || 'messages';
const SESSION_ON = process.env.WA_SESSION === '1';
const SEND_COMMAND = process.env.WA_SEND_COMMAND;
const SEND_VIA_SESSION = process.env.WA_SEND_VIA_SESSION === '1';

const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);

if (!DB_PATH) {
  console.error('WA_ARCHIVE_DB is not set - point it at your WhatsApp archive .db file');
  process.exit(2);
}

// ------------------------------------------------------------------ live session (opt-in)

let session = null;
if (SESSION_ON) {
  session = new Session({
    dataDir: process.env.WA_SESSION_DIR || join(dirname(resolve(DB_PATH)), '.wa-session'),
    chromePath: process.env.WA_CHROME || undefined,
    headless: process.env.WA_HEADLESS !== '0',
    defaultCountry: process.env.WA_DEFAULT_COUNTRY || '',
    log,
  });
  // A brand-new install has no archive yet. The scraper is what fills it, so make sure the
  // table exists before the reader is asked to open it.
  if (TABLE === 'messages') {
    try {
      mkdirSync(dirname(resolve(DB_PATH)), { recursive: true });
      new ArchiveWriter(DB_PATH).close();
    } catch (err) {
      console.error(`could not prepare archive ${DB_PATH}: ${err.message}`);
      process.exit(2);
    }
  }
}

// ------------------------------------------------------------------ archive reader

let archive;
try {
  archive = new Archive(DB_PATH, { table: TABLE });
} catch (err) {
  console.error(`failed to open archive: ${err.message}`);
  process.exit(2);
}

// ------------------------------------------------------------------ sender (opt-in)

// With neither WA_SEND_COMMAND nor WA_SEND_VIA_SESSION the sender is never constructed and
// the send tools are never advertised, so a default install cannot message anyone.
let sender = null;
let sendVia = null;
if (SEND_COMMAND || SEND_VIA_SESSION) {
  if (SEND_VIA_SESSION && !session) {
    console.error('WA_SEND_VIA_SESSION=1 needs WA_SESSION=1 - there is no session to send through');
    process.exit(2);
  }
  const num = (name, fallback) => {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const v = Number(raw);
    if (!Number.isFinite(v) || v < 0) throw new Error(`${name} must be a non-negative number`);
    return v;
  };
  let transport;
  if (SEND_COMMAND) {
    let args = [];
    if (process.env.WA_SEND_ARGS) {
      try {
        args = JSON.parse(process.env.WA_SEND_ARGS);
        if (!Array.isArray(args)) throw new Error('not an array');
      } catch (err) {
        console.error(`WA_SEND_ARGS must be a JSON array of strings: ${err.message}`);
        process.exit(2);
      }
    }
    transport = commandTransport({ command: SEND_COMMAND, args });
    sendVia = `command ${SEND_COMMAND}`;
  } else {
    transport = (to, text) => session.sendText(to, text);
    sendVia = 'live session';
  }
  const pausedFile = process.env.WA_SEND_PAUSED_FILE;
  const blocklistFile = process.env.WA_SEND_BLOCKLIST;
  try {
    sender = new Sender({
      transport,
      statePath: process.env.WA_SEND_STATE || `${DB_PATH}.send-state.json`,
      maxPerDay: num('WA_SEND_MAX_PER_DAY', undefined),
      minGapSeconds: num('WA_SEND_MIN_GAP_SEC', undefined),
      duplicateWindowHours: num('WA_SEND_DUP_HOURS', undefined),
      window: process.env.WA_SEND_WINDOW || undefined,
      // Same code the live transport applies, so guard and transport cannot disagree.
      defaultCountry: process.env.WA_DEFAULT_COUNTRY || '',
      // Both are re-read on every call, so the kill switch and the blocklist take effect
      // immediately - no restart, and no window where a stale copy is still trusted.
      isPaused: () => !!pausedFile && existsSync(pausedFile),
      blocklist: () => {
        if (!blocklistFile || !existsSync(blocklistFile)) return new Set();
        try {
          return new Set(
            readFileSync(blocklistFile, 'utf8')
              .split('\n')
              // Normalised the same way a recipient is, so a blocklist written in local
              // form still matches a request made in international form, and vice versa.
              .map((l) => normaliseNumber(l.split('#')[0], process.env.WA_DEFAULT_COUNTRY || ''))
              .filter((d) => d.length >= 6)
          );
        } catch {
          // If the blocklist cannot be read we must not proceed as though it were empty.
          throw new Error(`blocklist ${blocklistFile} could not be read; refusing to send`);
        }
      },
    });
  } catch (err) {
    console.error(`send configuration is invalid: ${err.message}`);
    process.exit(2);
  }
}

// ------------------------------------------------------------------ tool definitions

const SINCE = {
  type: 'string',
  description: "Only messages at or after this time. ISO date ('2026-08-31'), ISO timestamp, or epoch seconds.",
};
const UNTIL = { ...SINCE, description: SINCE.description.replace('at or after', 'at or before') };
const LIMIT = {
  type: 'integer',
  description: 'Maximum rows to return (1-500, default 50).',
  minimum: 1,
  maximum: 500,
};
// Kept in step with package.json rather than hand-maintained, so a client inspecting the
// initialize response is not told a different version from the one it installed.
const VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const LIVE_CAVEAT =
  ' This reads the linked DEVICE, whose store is a best-effort window of the phone\'s ' +
  'history - it may be thinner than the phone shows, and our own outbound to a chat this ' +
  'device created never syncs back. Use wa_request_history and re-read if a chat looks ' +
  'thin; use wa_sync to fold what is here into the archive.';

const TOOLS = [
  {
    name: 'wa_stats',
    description:
      'Summarise the archive: how many messages and chats it holds, the inbound/outbound ' +
      'split, and the time range it covers. Call this first when an absence of results ' +
      'might mean "the archive does not go back that far" rather than "it never happened".',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: () => archive.stats(),
  },
  {
    name: 'wa_list_chats',
    description:
      'List archived chats with message counts and last activity, most recently active ' +
      'first. Use `query` to filter by chat name (or thread tag). `includes_name_matched` ' +
      'marks a chat whose older messages carry no id of their own and were matched to it by ' +
      'name - normally the same chat before ids existed, but worth a look if two of your ' +
      'chats share a name.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Substring match on chat name or tag.' },
        groups_only: { type: 'boolean', description: 'Only group chats.' },
        direct_only: { type: 'boolean', description: 'Only one-to-one chats.' },
        limit: LIMIT,
      },
      additionalProperties: false,
    },
    handler: (a) => archive.listChats({
      query: a.query, limit: a.limit, groupsOnly: a.groups_only, directOnly: a.direct_only,
    }),
  },
  {
    name: 'wa_read_chat',
    description:
      'Read one archived conversation in chronological order. Address it by `chat_id` ' +
      '(exact, from wa_list_chats - the only unambiguous way, since two groups can share ' +
      'a name), by `chat` (substring of the chat name), or by `tag` (exact thread tag, if ' +
      'the archive has them). A `chat` name matching more than one chat is refused rather ' +
      'than interleaving two conversations. A `limit` returns the MOST RECENT n messages, ' +
      'still presented oldest-first.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string', description: 'Exact chat id from wa_list_chats.' },
        chat: { type: 'string', description: 'Substring of the chat name.' },
        tag: { type: 'string', description: 'Exact thread tag.' },
        since: SINCE,
        until: UNTIL,
        limit: LIMIT,
      },
      additionalProperties: false,
    },
    handler: (a) => archive.readChat({
      chat: a.chat, chatId: a.chat_id, tag: a.tag, since: a.since, until: a.until,
      limit: a.limit,
    }),
  },
  {
    name: 'wa_search',
    description:
      'Search archived message bodies for a substring across every chat, newest first. ' +
      'Optionally restrict by thread tag, direction, or time window.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Substring to look for (case-insensitive).' },
        tag: { type: 'string', description: 'Restrict to one thread tag.' },
        from_me: { type: 'boolean', description: 'true = only sent, false = only received.' },
        include_groups: { type: 'boolean', description: 'Include group chats (default true).' },
        since: SINCE,
        until: UNTIL,
        limit: LIMIT,
      },
      required: ['text'],
      additionalProperties: false,
    },
    handler: (a) => archive.searchMessages({
      text: a.text, tag: a.tag, fromMe: a.from_me, includeGroups: a.include_groups,
      since: a.since, until: a.until, limit: a.limit,
    }),
  },
  {
    name: 'wa_unanswered',
    description:
      'Archived chats whose most recent message came from the other party - i.e. someone ' +
      'is waiting on a reply. Group chats are excluded unless `include_groups` is set. Note ' +
      'this reflects the archive only: a reply sent from another device that has not been ' +
      'synced yet will still look unanswered.',
    inputSchema: {
      type: 'object',
      properties: {
        since: SINCE,
        include_groups: { type: 'boolean', description: 'Include group chats (default false).' },
        limit: LIMIT,
      },
      additionalProperties: false,
    },
    handler: (a) => archive.unanswered({
      since: a.since, includeGroups: a.include_groups, limit: a.limit,
    }),
  },
];

if (session) {
  TOOLS.push(
    {
      name: 'wa_session_status',
      description:
        'State of the live WhatsApp session: not_started, connecting, needs_qr, ready, ' +
        'disconnected or failed. When needs_qr, the response names the PNG to scan with ' +
        'the phone (WhatsApp > Linked devices > Link a device). Calling any live tool ' +
        'starts the session if it is not running; this one never does.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: () => session.status(),
    },
    {
      name: 'wa_live_chats',
      description:
        'Chats as the linked device holds them right now, with unread counts and the ' +
        'number behind each direct chat. Starts the session if needed (first call can take ' +
        'a minute; a fresh install needs a QR scan first).' + LIVE_CAVEAT,
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Substring match on the chat name.' },
          groups_only: { type: 'boolean' },
          direct_only: { type: 'boolean' },
          limit: LIMIT,
        },
        additionalProperties: false,
      },
      handler: (a) => session.listChats({
        query: a.query, limit: a.limit, groupsOnly: a.groups_only, directOnly: a.direct_only,
      }),
    },
    {
      name: 'wa_live_read',
      description:
        'Read one chat from the live device, oldest-first, paging history back until ' +
        '`since` is covered, though paging back is currently broken on WhatsApp Web - when ' +
        '`paging_error` comes back non-null you are seeing only what the device had already ' +
        'loaded, so call wa_request_history, wait a few seconds and read again. ' +
        'Address by `chat_id` (exact, from wa_live_chats), `number`, ' +
        'or `chat` (name substring). Each message carries an `id` usable with ' +
        'wa_fetch_media when `has_media` is true.' + LIVE_CAVEAT,
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: { type: 'string', description: 'Exact chat id from wa_live_chats.' },
          number: { type: 'string', description: 'Phone number; any formatting.' },
          chat: { type: 'string', description: 'Substring of the chat name.' },
          since: { type: 'string', description: 'ISO date or timestamp; page history back to here.' },
          limit: LIMIT,
        },
        additionalProperties: false,
      },
      handler: (a) => session.readChat({
        chatId: a.chat_id, number: a.number, chat: a.chat, since: a.since, limit: a.limit,
      }),
    },
    {
      name: 'wa_resolve',
      description:
        'Is this number on WhatsApp, and what does the device know about it - the ' +
        'WhatsApp id, whether a chat exists, the name it shows under. The identity check ' +
        'to run before trusting that a number belongs to who a spreadsheet says it does.',
      inputSchema: {
        type: 'object',
        properties: { number: { type: 'string', description: 'Phone number; any formatting.' } },
        required: ['number'],
        additionalProperties: false,
      },
      handler: (a) => session.resolve(a.number),
    },
    {
      name: 'wa_request_history',
      description:
        'Ask the phone to push a chat\'s history to this device - what a human opening ' +
        'the chat triggers. Fire this, wait a few seconds, then wa_live_read again when a ' +
        'chat came back thinner than expected.',
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: { type: 'string' },
          number: { type: 'string' },
        },
        additionalProperties: false,
      },
      handler: (a) => session.requestHistory({ chatId: a.chat_id, number: a.number }),
    },
    {
      name: 'wa_fetch_media',
      description:
        'Download the media attached to one message (from wa_live_read, where has_media ' +
        'is true) and save it to disk. Returns the file path, size and mime type - never ' +
        'the bytes. Files are named by content hash, so fetching twice is harmless.',
      inputSchema: {
        type: 'object',
        properties: {
          message_id: { type: 'string', description: 'Message id from wa_live_read.' },
          chat_id: { type: 'string', description: 'Narrows the search; optional but faster.' },
          number: { type: 'string' },
          out_dir: { type: 'string', description: 'Sub-directory of the session media folder to save into. Relative; it cannot escape that folder.' },
        },
        required: ['message_id'],
        additionalProperties: false,
      },
      handler: async (a) => {
        const res = await session.fetchMedia({ chatId: a.chat_id, number: a.number, messageId: a.message_id });
        const buf = Buffer.from(res.data, 'base64');
        const ext = ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'video/mp4': 'mp4',
                       'audio/ogg': 'ogg', 'application/pdf': 'pdf' })[res.mimetype] || 'bin';
        // out_dir is a tool argument and the bytes are whatever a contact sent, so an
        // absolute path or a .. would let a caller drop content of someone else's choosing
        // anywhere writable. Resolve inside the media root and refuse to leave it.
        const mediaRoot = resolve(join(session.dataDir, 'media'));
        const dir = a.out_dir ? resolve(mediaRoot, a.out_dir) : mediaRoot;
        if (dir !== mediaRoot && !dir.startsWith(mediaRoot + sep)) {
          throw new Error('out_dir must stay inside the session media directory');
        }
        mkdirSync(dir, { recursive: true });
        const sha1 = createHash('sha1').update(buf).digest('hex');
        const name = sha1 + '.' + ext;
        const path = join(dir, name);
        if (!existsSync(path)) writeFileSync(path, buf);
        return { path, bytes: buf.length, mimetype: res.mimetype, sha1 };
      },
    },
    {
      name: 'wa_sync',
      description:
        'Scrape the live device into the archive: every chat (or those matching `query`), ' +
        'messages from the last `days`, inserted with duplicate suppression so running it ' +
        'repeatedly is safe. After this the archive tools (wa_search, wa_unanswered, ...) ' +
        'see what the device held. `tag_regex` derives a thread tag from each chat name ' +
        'via its first capture group, e.g. "(\\\\d{3} \\\\d{2}-\\\\d{2,3})".' + LIVE_CAVEAT,
      inputSchema: {
        type: 'object',
        properties: {
          days: { type: 'integer', description: 'How far back to page (default 7).', minimum: 1, maximum: 365 },
          query: { type: 'string', description: 'Only chats whose name contains this.' },
          groups_only: { type: 'boolean' },
          direct_only: { type: 'boolean' },
          max_chats: { type: 'integer', minimum: 1, maximum: 500, description: 'Default 200.' },
          per_chat: { type: 'integer', minimum: 1, maximum: 50000,
            description: 'Messages to take from each chat (default 2000). Chats that hit it are '
              + 'named in chats_hit_limit - raise it or narrow `days` to get the rest.' },
          tag_regex: { type: 'string', description: 'Regex with one capture group, applied to the chat name.' },
        },
        additionalProperties: false,
      },
      handler: async (a) => {
        let tagRe = null;
        if (a.tag_regex) {
          try { tagRe = new RegExp(a.tag_regex); } catch (e) { throw new Error(`bad tag_regex: ${e.message}`); }
        }
        const days = a.days ?? 7;
        const since = new Date(Date.now() - days * 86_400_000).toISOString();
        const chats = await session.listChats({
          query: a.query, limit: a.max_chats ?? 200, groupsOnly: a.groups_only, directOnly: a.direct_only,
        });
        const writer = new ArchiveWriter(DB_PATH);
        const perChat = a.per_chat ?? 2000;
        const totals = { days, per_chat: perChat, chats_scanned: 0, chats_with_messages: 0,
                         messages_seen: 0, inserted: 0, skipped: 0, media: 0, chats_hit_limit: [] };
        try {
          for (const c of chats) {
            totals.chats_scanned++;
            const r = await session.readChat({ chatId: c.id, limit: perChat, since });
            if (!r.found || !r.messages.length) continue;
            totals.chats_with_messages++;
            const m = tagRe ? tagRe.exec(c.name) : null;
            const tag = m && m[1] ? m[1] : null;
            const rows = r.messages.map((x) => ({
              chat: c.name, chat_id: c.id, msg_id: x.id || null,
              tag, is_group: c.is_group, from_me: x.from_me,
              ts: x.ts, body: x.body, author: x.author || null,
              type: x.type || null, has_media: !!x.has_media, mimetype: x.mimetype || null,
            }));
            const u = writer.upsert(rows);
            totals.messages_seen += rows.length;
            totals.inserted += u.inserted;
            totals.skipped += u.skipped;
            totals.media += u.media;
            // A chat that filled its budget probably has more history behind it.
            if (r.messages.length >= perChat) totals.chats_hit_limit.push(c.name);
          }
        } finally {
          writer.close();
        }
        return totals;
      },
    },
  );
}

if (sender) {
  TOOLS.push(
    {
      name: 'wa_send_status',
      description:
        'What the sender would allow right now: whether it is paused, whether the current ' +
        'time is inside the send window, how much of the daily quota is left, and when the ' +
        'last message went out. Check this before planning a batch.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: () => ({ via: sendVia, ...sender.status() }),
    },
    {
      name: 'wa_send',
      description:
        'Send ONE WhatsApp message, subject to guards that can only refuse: kill switch, ' +
        'blocklist, send window (only when WA_SEND_WINDOW is set), daily cap (only when ' +
        'WA_SEND_MAX_PER_DAY is set; 30 a day is the recommendation), minimum gap between ' +
        'sends, and duplicate ' +
        'suppression (the same text to the same recipient inside the duplicate window is ' +
        'rejected). Returns {sent:false, reason} when a guard refuses - that is a normal ' +
        'outcome, not an error to route around. Use dry_run to see the verdict without ' +
        'sending; it runs exactly the same checks. Send one message per call and read the ' +
        'result before the next: the guards are a backstop, not a substitute for judgement ' +
        'about whether this person should be messaged at all.',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Recipient phone number; any formatting.' },
          text: { type: 'string', description: 'Message body.' },
          dry_run: {
            type: 'boolean',
            description: 'Run every guard and report the verdict, but do not send.',
          },
        },
        required: ['to', 'text'],
        additionalProperties: false,
      },
      handler: (a) => sender.send(a.to, a.text, { dryRun: !!a.dry_run }),
    },
  );
}

// ------------------------------------------------------------------ server

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

const server = new Server(
  { name: 'whatsapp-mcp', version: VERSION },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = BY_NAME.get(req.params.name);
  if (!tool) {
    return {
      isError: true,
      content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }],
    };
  }
  try {
    const rows = await tool.handler(req.params.arguments ?? {});
    const payload = Array.isArray(rows) ? { count: rows.length, rows } : rows;
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 1) }] };
  } catch (err) {
    // Report the reason rather than a stack: a bad date, a missing column or a session that
    // still needs its QR scanned are all things the caller can act on, and the message says which.
    return { isError: true, content: [{ type: 'text', text: String(err.message || err) }] };
  }
});

const shutdown = async () => {
  try { archive.close(); } catch { /* nothing useful left to do */ }
  if (session) { try { await session.close(); } catch { /* browser already gone */ } }
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await server.connect(new StdioServerTransport());
log(
  `whatsapp MCP ready - archive ${DB_PATH} (table: ${TABLE}); ` +
  (session ? `live session ON (${session.dataDir}); ` : 'live session off; ') +
  (sender ? `sending ENABLED via ${sendVia}` : 'no send tools')
);

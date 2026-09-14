# whatsapp-mcp

An MCP server that lets an assistant read your WhatsApp history, and — if you explicitly turn
it on — send messages, behind guards that can only refuse.

It comes in three layers, each off until you enable it:

1. **Archive reader** — typed tools over a SQLite archive of your messages, so an assistant can
   answer "what did we actually say to this person, and when?" without hand-writing SQL.
   Read-only.
2. **Live scraper** — links its *own* WhatsApp Web device, reads chats, resolves numbers,
   downloads media, and syncs the device into the archive.
3. **Guarded sender** — one message per call, through a chain of checks that can only say no.

**With nothing configured beyond the archive path, no browser is launched and no tool exists
that can send anything.**

---

## Read this before you use it

**Automating a personal WhatsApp account is against WhatsApp's Terms of Service, and accounts
do get restricted for it.** This is not hypothetical: roughly 48 first-contact messages in a
single day has been enough to get an account restricted. Identical text sent to
many people who have never messaged you looks exactly like spam from the outside, because it is
indistinguishable from it.

If you use the sender at all:

- Keep the volume low. `WA_SEND_MAX_PER_DAY=30` is the recommended setting for a personal
  account, and messaging strangers is far riskier than replying to people who wrote to you.
- Treat a restriction as a possibility you have accepted, not an accident. A second one can be
  permanent.
- For anything resembling business messaging at volume, use the official
  [WhatsApp Business Platform](https://business.whatsapp.com/) instead. This tool is for your
  own account and your own conversations.

Two more things worth knowing before you point an assistant at your messages. Everything the
tools return — message bodies, contact names, your own number — flows into whatever model is
behind your MCP client, so it matters whether that is local or hosted. And message content is
untrusted input: if you let an assistant act on what it reads, a message written by someone
else is a way to try to influence it.

---

## Requirements

- **Node 22.5 or newer.** It uses the built-in `node:sqlite`, so there is no native module to
  compile and no build step.
- **A local Chrome**, only for the live layer. The server drives an installed Chrome rather
  than downloading its own; it looks in the usual place for your platform and `WA_CHROME`
  overrides that.

```bash
npm install
npm test
```

## Quick start

**1. Link a device** (only needed for the live layer). This opens WhatsApp Web in its own Chrome
profile and writes a QR code for you to scan.

```bash
WA_SESSION_DIR=./.wa-profile WA_LINK_TIMEOUT_SEC=600 npm run link
```

On Windows `cmd.exe`, environment variables are set separately:

```bat
set "WA_SESSION_DIR=.\.wa-profile" && set "WA_LINK_TIMEOUT_SEC=600" && npm run link
```

Scan `qr.png` in that directory — or open the auto-refreshing `qr.html` beside it — from
WhatsApp › Settings › Linked devices › Link a device. The login persists in the profile
directory; you do this once.

**2. Add it to your MCP client.** For Claude Code, one command registers it everywhere:

```bash
claude mcp add --scope user whatsapp -e WA_ARCHIVE_DB=./whatsapp.db -e WA_SESSION=1 -e WA_SESSION_DIR=./.wa-profile -- node --no-warnings ./src/server.js
```

Or add it to a project's `.mcp.json` by hand:

```json
{
  "mcpServers": {
    "whatsapp": {
      "command": "node",
      "args": ["--no-warnings", "/absolute/path/to/whatsapp-mcp/src/server.js"],
      "env": {
        "WA_ARCHIVE_DB": "/absolute/path/to/whatsapp.db",
        "WA_SESSION": "1",
        "WA_SESSION_DIR": "/absolute/path/to/whatsapp-mcp/.wa-profile",
        "WA_DEFAULT_COUNTRY": "65"
      }
    }
  }
}
```

The archive file is created if it does not exist. Leave out `WA_SESSION` and `WA_SESSION_DIR`
for a client that should only query an archive someone else maintains. Nothing above enables
sending — see [Sending](#sending) for that, deliberately.

**One process per login.** The profile is a Chrome profile and Chrome allows one process per
profile, so two clients cannot run the live layer against the same profile at once.

## Configuration

### Reading

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `WA_ARCHIVE_DB` | yes | — | Path to the SQLite archive |
| `WA_ARCHIVE_TABLE` | no | `messages` | Table holding the messages |

### Live session — omit `WA_SESSION` and no browser is ever launched

| Variable | Default | Meaning |
|---|---|---|
| `WA_SESSION` | — | Set to `1` to enable the live layer |
| `WA_SESSION_DIR` | `<db dir>/.wa-session` | Login profile directory; the QR lands here on first run |
| `WA_CHROME` | first Chrome found for your platform | Chrome executable |
| `WA_HEADLESS` | `1` | Set `0` to watch the browser work |
| `WA_DEFAULT_COUNTRY` | — | Digits prepended to bare local numbers, e.g. `65` |

### Sending — omit both `WA_SEND_COMMAND` and `WA_SEND_VIA_SESSION` to stay read-only

| Variable | Default | Meaning |
|---|---|---|
| `WA_SEND_COMMAND` | — | External command that performs a send. **This or `WA_SEND_VIA_SESSION` enables the send tools.** |
| `WA_SEND_VIA_SESSION` | — | Set to `1` to send natively through the live session (needs `WA_SESSION=1`) |
| `WA_SEND_ARGS` | `[]` | JSON array of arguments; `{to}` and `{text}` are substituted |
| `WA_SEND_STATE` | `<db>.send-state.json` | Quota, duplicate history and audit trail |
| `WA_SEND_MAX_PER_DAY` | none | Cap per local day. Unset means no cap; **30 is the recommended value** |
| `WA_SEND_WINDOW` | none | Local hours when sending is allowed, e.g. `09:00-21:00` (may wrap midnight) |
| `WA_SEND_MIN_GAP_SEC` | `5` | Minimum seconds between two sends |
| `WA_SEND_DUP_HOURS` | `24` | Window in which the same text to the same person is refused |
| `WA_SEND_PAUSED_FILE` | — | Kill switch: while this file exists, every send is refused |
| `WA_SEND_BLOCKLIST` | — | File of numbers (one per line, `#` comments) never to message |

Keep `WA_SEND_BLOCKLIST` and `WA_SEND_STATE` outside the repository. The blocklist holds other
people's numbers and the state file holds your sending history; neither belongs in version
control, and only the default state filename is covered by `.gitignore`.

## Tools

| Tool | Purpose |
|---|---|
| `wa_stats` | Message and chat counts, inbound/outbound split, time range covered |
| `wa_list_chats` | Chats with counts and last activity, most recent first |
| `wa_read_chat` | One conversation in chronological order, by `chat_id`, name or tag |
| `wa_search` | Substring search across bodies, filterable by tag, direction and time |
| `wa_unanswered` | Chats whose last message came from the other party |
| `wa_session_status` | Session state; names the QR to scan when one is needed — *live* |
| `wa_live_chats` | Chats as the device holds them now, with unread counts and numbers — *live* |
| `wa_live_read` | One chat from the device, paging history back to `since` — *live* |
| `wa_resolve` | Is a number on WhatsApp, and who does the device say it is — *live* |
| `wa_request_history` | Ask the phone to push a chat's history to the device — *live* |
| `wa_fetch_media` | Download one message's media, named by content hash; takes a live id **or** an archived `msg_id` — *live* |
| `wa_sync` | Scrape the device into the archive, duplicate-safe, media included — *live* |
| `wa_send_status` | Quota left, window state, kill switch — *sending only* |
| `wa_send` | Send one message through the guard chain — *sending only* |

Two behaviours worth knowing:

**`wa_read_chat` with a `limit` returns the most recent N messages, presented oldest-first.**
Asking for "the last 20" gives the latest 20 in reading order, not the oldest 20 of the thread.

**`wa_unanswered` is structural, not semantic.** It reports threads whose final message is
inbound. A closing "ok, thanks" counts as unanswered, because nothing here judges whether a
message deserved a reply. It also only knows what has been scraped.

## Live session

With `WA_SESSION=1` the server links **its own** device — its own profile, its own QR. It never
touches another tool's session, so it cannot contend with one for the same login.

Nothing is launched until a live tool is actually called (`wa_session_status` excepted, which
only reports). The first live call after a restart takes about a minute: WhatsApp Web has to
load, and then the server waits for the device's message store to stop changing before reading,
because an offline device receives its queued messages only *after* connecting.

**The store is not the phone.** A linked device holds a best-effort window of history that
hydrates over minutes to hours, and your own outbound to a chat the device created never syncs
back. Every live tool says so in its description. When a chat reads thinner than the phone
shows, `wa_request_history` asks the phone to push it — then read again.

**Paging back through history is broken on the current WhatsApp Web build** (checked 7 Sep 2026).
`loadEarlierMsgs` throws on every call, reaching for page context a headless boot does not set
up, so a read returns whatever the device had already loaded rather than paging further back.
Reads say so: `paging_error` comes back non-null instead of the result quietly looking like the
start of the chat. `wa_request_history` is the way to get more — it asks the phone to push, which
is a different mechanism and still works. This is the part of the project most exposed to
WhatsApp changing its internals, and it is why the tools report how they got their answer.

**Disconnections recover on the next call.** Chrome can be closed, crash, or be killed. The
session notices immediately — the state turns `disconnected` rather than continuing to claim it
is ready — and the next tool call relaunches the browser, reuses the saved login, and retries
once. Measured: a hard kill of Chrome mid-session, then a call that recovered in 27 seconds
without a QR.

**Linking can need patience.** WhatsApp intermittently answers a fresh, unlinked profile with
`?post_logout=1` and then "A database error occurred on your browser", and it does so in
streaks — the identical boot reached a QR five times out of five in one window and zero out of
five an hour later. Creating many fresh sessions quickly appears to make it worse. The session
recovers on its own, reloading and then discarding the still-unlinked profile, and keeps
retrying until your timeout. Give `WA_LINK_TIMEOUT_SEC` room and do not re-run the link in a
loop. Once a device is linked, this path is not travelled again.

`wa_sync` folds whatever the device holds into the archive with duplicate suppression, so the
archive tools work over it. Re-syncing the same window inserts nothing. It takes `per_chat`
messages from each chat (default 2000) and reports a `media` count plus `chats_hit_limit`, the
chats that filled their budget and probably have more history behind them. `tag_regex` derives
a thread tag from each chat name via its first capture group.

## Sending

Sending is off until either `WA_SEND_COMMAND` or `WA_SEND_VIA_SESSION=1` is set. Until then the
server constructs no sender and advertises no send tool, so a default install cannot message
anyone.

Two transports. **Via the live session** (`WA_SEND_VIA_SESSION=1`) sends natively through the
device the server linked. **Via a command** (`WA_SEND_COMMAND`) hands each message to a program
you nominate — your own script, a Cloud API call, anything that reads `WA_TO` and `WA_MSG` from
the environment — for when the login that should send belongs to something else. The recipient
and body are passed as environment variables and the child is spawned without a shell, so a
message containing quotes, newlines or `; rm -rf` is inert.

### The guard chain

Every send passes these in order, and each can only refuse:

| Guard | Refuses when |
|---|---|
| kill switch | `WA_SEND_PAUSED_FILE` exists |
| blocklist | the recipient is listed |
| send window | `WA_SEND_WINDOW` is set and local time is outside it |
| daily cap | `WA_SEND_MAX_PER_DAY` is set and already reached today |
| burst gap | fewer than `WA_SEND_MIN_GAP_SEC` since the last send |
| duplicate | the same text went to the same person inside `WA_SEND_DUP_HOURS` |

A refusal comes back as `{sent: false, reason: "..."}` — a normal result, not an error. The kill
switch and blocklist are re-read on every call, so both take effect immediately without a
restart. `dry_run: true` runs the identical chain and reports the verdict without sending; it
calls the same function the real path does, so the two cannot drift apart.

**The blocklist compares the number that will actually be dialled.** Both the guard and the
transport normalise through one function, including `WA_DEFAULT_COUNTRY`, so a blocklist holding
`6591234567` also refuses a request for `91234567` when the country code is configured. These
used to be two separate definitions, and the local form walked straight past the guard.

**Sends are serialised.** Two overlapping `wa_send` calls would otherwise both pass the guards
against the same pre-send state, defeating the gap, duplicate and cap checks between them.

**Sends are never retried automatically.** Reads are retried through a dropped browser, because
a repeated read costs nothing; a repeated send is a second message to a real person. If the
connection drops after the message was handed to WhatsApp, the outcome is genuinely unknown, so
the result is `{sent: false, uncertain: true}` with advice to read the chat before trying again.
That case counts against the quota and the duplicate window — the failure worth avoiding is
messaging someone twice, not under-counting a day's allowance.

State survives restarts, a failed send is logged but does not consume quota, and message bodies
are stored only as a hash: enough to catch a duplicate, not enough to make the state file a
second copy of your conversations.

### What the guards are not

They are a backstop against mechanical mistakes: the same message twice, a burst, the middle of
the night, someone who asked not to be contacted. They know nothing about whether this person
should be hearing from you at all, whether the content is right, or whether they have already
been told by someone else. `wa_send` takes one message per call by design, so each send is a
decision rather than an iteration.

## The archive

The server adapts to the archive it is given rather than demanding one shape. At startup it
inspects the table and maps each logical field onto whichever column exists:

| Logical field | Required | Accepted column names |
|---|---|---|
| `ts` | yes | `ts`, `timestamp`, `time`, `sent_at`, `date` — epoch **seconds** |
| `body` | yes | `body`, `text`, `message`, `content` |
| `from_me` | yes | `from_me`, `fromMe`, `is_outgoing`, `outgoing` |
| `chat` | no | `chat`, `chat_name`, `conversation`, `thread` |
| `chat_id` | no | `chat_id`, `chatId`, `thread_id` |
| `msg_id` | no | `msg_id`, `message_id` — the id `wa_fetch_media` needs |
| `tag` | no | `tag`, `unit`, `label`, `ref` |
| `author` | no | `author`, `sender`, `from`, `participant` |
| `is_group` | no | `is_group`, `isGroup`, `group` |
| `type` | no | `type`, `msg_type` |
| `has_media` | no | `has_media`, `hasMedia` |
| `mimetype` | no | `mimetype`, `mime_type`, `mime` |
| `id_inferred` | no | `id_inferred` — set when a row's chat id came from its chat name |

A missing required column makes the server refuse to start and name what it could not find,
rather than returning quietly wrong answers later. `wa_stats` reports which optional fields a
given archive actually carries. Note that a generic `id` column is deliberately *not* read as a
message id — in a foreign archive that is usually a row number, and handing a row number to
`wa_fetch_media` fails confusingly.

### What it keeps, and why identity matters

**A photo with no caption is still a message.** Rows are kept whenever they carry media, even
with an empty body; only rows with neither text nor media are dropped. An earlier version keyed
on a non-empty body and silently lost every uncaptioned photo — often the most important thing
in the thread.

**Rows are deduplicated by message id, not by name and text.** Keying on
(chat name, timestamp, direction, body) merges two photos posted in the same second, because
both have an empty body, and merges two groups that share a display name. `dedup_key` prefers
the WhatsApp message id and only falls back to a content composite when there is none.

**Storing `msg_id` is what makes an archived photo retrievable.** Pass one straight to
`wa_fetch_media`; without it an archived image is a row that mentions a picture nobody can open.

**A thread is its id plus the names that belong only to it.** Neither column alone identifies a
chat in a migrated archive: filtering by name loses the messages sent before a group was
renamed, and filtering by id loses the messages that predate the id columns. Reads resolve both.
Two chats that both know their ids are never merged, and reading such a name is refused with the
ids instead of interleaving two conversations.

That resolution works by matching names against rows that carry an id, which means it has one
blind spot worth knowing: **a group renamed before it was ever scraped with an id stays split.**
Its old name never appears beside any id, so nothing can bridge the two halves, and
`includes_name_matched` reads false because no assumption was even attempted. The old messages
are still in the archive under the old name; they just do not join the renamed thread. Renames
that happen after a chat has an id are handled correctly.

Where a name is known by exactly one id, its id-less rows are treated as part of that chat. That
is the common case after a migration, since every chat starts id-less and only recent messages
get ids back — but it is an assumption, so `wa_list_chats` reports `includes_name_matched` on
any chat holding messages matched by name. Nothing is gated on it; it is there so the assumption
can be checked instead of being invisible. On a normal archive it is false everywhere.

### Migrating an older archive

An archive written before the identity columns existed is migrated in place on the next write.
The columns are added, nullable, so an older reader keeps working, and the table is **rebuilt to
drop the old `UNIQUE(chat, ts, from_me, body)` constraint**. That rebuild is not cosmetic: the
constraint belongs to the table, so adding a better key beside it changes nothing and
`INSERT OR IGNORE` would still discard the second of two captionless photos. SQLite has no
`DROP CONSTRAINT`, so the table is recreated without it and every row carried across, then
existing rows are given a `dedup_key` so a later sync still recognises them.

A migrated archive is half-and-half, and both halves have to keep working. Queries fall back to
the chat name where the id is NULL. A re-scrape looks its message up under the key the migration
gave it and upgrades that row in place rather than inserting a copy. When a batch reveals the id
behind a name, the chat's older rows adopt it, so a thread does not read as two chats forever —
skipped when the name is ambiguous.

Measured on a 13,653-message archive: 0.2 seconds to migrate, identical message and chat counts
before and after, every column preserved including a `unit` tag column it did not create, and a
partial re-sync that upgraded and healed rows without changing either count.

## Implementation notes

This server drives Chrome itself rather than going through `whatsapp-web.js`, and reads through
WhatsApp Web's own in-page modules. Both are deliberate. The library's wrappers (`getChats`,
`fetchMessages`, `downloadMedia`) have thrown on every build since mid-2026, and its
`initialize()` cannot link a new device at all: it holds a `page.evaluate` open across
WhatsApp's own `?post_logout=1` self-reset, so the reset destroys the execution context and it
dies with "Execution context was destroyed" before emitting a QR — zero QRs in fifteen fresh
attempts when measured, pinned or not, headless or headed. Polling the page instead simply
survives that navigation.

Two consequences. The QR is captured as a screenshot of the page's own canvas, so nothing has to
reconstruct the login payload. And the state probe touches **only the DOM** while the app is
starting: reaching into `window.require` before WhatsApp has finished booting destabilises it,
which is also where the library breaks.

It depends on `puppeteer-core` rather than `puppeteer`, because it always drives an installed
Chrome and the bundled-Chromium download was the source of the only dependency advisories the
project had.

## Tests

```bash
npm test
```

140 tests, no framework beyond `node --test`. They cover the query layer (including against a
deliberately foreign schema, to prove the adapter works); the writer's duplicate suppression,
rollback and in-place migration; the mixed-state archives a migration leaves behind — a renamed
chat, a half-identified one, a tag on only some rows, a name carrying LIKE wildcards, a hostile
column type, and two guards on how long a listing may take; the guard chain with an injected
clock and transport, including the blocklist normalisation and concurrent sends; the command
transport with a hostile message body, to prove nothing reaches a shell; and the server
end-to-end over real MCP stdio in read-only, send-enabled and session-enabled modes.

What the tests cannot cover is the live session itself, which needs a phone to scan a QR. They
prove the layer is absent until enabled, launches no browser until a live tool is called, and
reports a misconfigured Chrome path as a readable error. The live tools and the native send were
exercised by hand against a linked device: chats listed, a chat read, a number resolved, thirty
days synced into a fresh archive, a photo downloaded straight from an archived id, one message
sent and read back from the chat, and a hard-killed Chrome recovered from.

## License

MIT — see [LICENSE](LICENSE).

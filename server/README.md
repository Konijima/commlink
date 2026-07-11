# commlink server

The pub/sub push-notification server: Node.js + TypeScript, Fastify, WebSocket, and
SQLite. It accepts published messages over HTTP and streams them to subscribed clients
over WebSocket.

> Early development. Publishing, both subscribe routes, the message cache, `?since=`
> replay, retention, bearer-token auth, publish rate limiting, the payload and metadata
> size caps, graceful shutdown, `.env` loading and structured logging are live. The
> Android client is next — see [`../TODO.md`](../TODO.md).

## Requirements

- Node.js 22+
- [pnpm](https://pnpm.io)

The SQLite driver ships prebuilt binaries for common platforms. On anything else it is
compiled during install, which needs a C++ toolchain.

## Development

```bash
pnpm install
pnpm test              # vitest
pnpm typecheck         # tsc --noEmit
pnpm token:create me   # mint a token to publish and subscribe with
pnpm token:list        # show the tokens this server has issued
pnpm token:revoke me   # revoke one by name
pnpm dev               # start on http://127.0.0.1:4500
pnpm build             # compile to dist/
pnpm smoke             # boot the compiled server and check /healthz
```

`pnpm start` runs the compiled server from `dist/`, which is what a service unit should
invoke. `pnpm smoke` builds nothing — it starts `dist/` on a free port with a throwaway
database and fails if the process dies or `/healthz` is unhealthy.

```bash
curl http://127.0.0.1:4500/healthz
# {"status":"ok","uptime":12.34}
```

## Authentication

Every route but `/healthz` needs a bearer token, and a server whose database holds no
tokens authorizes nobody. So the first thing to do with a fresh install is mint one:

```bash
pnpm token:create pixel
# Token "pixel" created in ./commlink.sqlite. It is shown once:
# 5PjK…                                    <- the token, alone on stdout
# Store it now; only its hash was written down.
```

The name is a label for you — `pixel`, `laptop`, `ci` — and each name may be used once.
Only a SHA-256 of the token is stored, so a lost token is replaced rather than
recovered, and a stolen database yields nothing that can be presented back to the
server. Tokens live in the same database as the messages, so the token commands and the
server must be pointed at the same `DB_PATH`.

### Managing tokens

`token:list` shows what has been issued — the id the server knows each token by, the
name it was minted under, and when. Neither the token nor its hash is printed, because
neither is stored in a form that could be:

```bash
pnpm --silent token:list
# 1	pixel	2026-07-10T09:12:44Z
# 2	laptop	2026-07-10T09:13:02Z
```

The columns are tab-separated and the headings go to stderr, so `pnpm --silent
token:list | cut -f2` names the tokens for a script.

`token:revoke` deletes one by name, and the token stops working at once — every request
is looked up against the database as it arrives, so a running server needs no restart:

```bash
pnpm token:revoke pixel
# Token "pixel" revoked from ./commlink.sqlite. It no longer authorizes anything.
```

Revoking a name that was never minted is an error rather than a no-op: a mistyped name
would otherwise be indistinguishable from a token successfully revoked. Afterwards the
name is free to mint again, and the replacement is a new token with a new id — so it
starts with a fresh [rate-limit](#rate-limit) budget rather than inheriting whatever the
revoked one had spent.

A subscriber already holding an open stream is cut off too, without a reconnect or a
restart. Every keepalive interval (45s) the server re-checks each open subscriber's token
against the database and drops one whose token has been revoked — a WebSocket is closed
with `1008 "token revoked"` and a `/json` stream is ended — so a revoked subscriber stops
within one interval of the revoke. Restart the server to disconnect one instantly rather
than waiting the interval out.

Publishers and `/json` subscribers send the token as a header:

```bash
curl -H "Authorization: Bearer $TOKEN" -d "hello" http://127.0.0.1:4500/mytopic
```

A browser cannot set a header on a WebSocket handshake, so both subscribe routes also
take the token as `?auth=`:

```bash
websocat "ws://127.0.0.1:4500/mytopic/ws?auth=$TOKEN"
```

Publishing does not take `?auth=`. A query string is the part of a URL that proxies and
access logs write down, and a publisher is a program that can always set a header.

A request with no token, an unreadable one, or one that was never issued is answered
with `401` and a `WWW-Authenticate: Bearer` challenge; the three are not told apart. On
`/:topic/ws` that `401` refuses the handshake, so no socket is ever opened.

`/healthz` is the exception, because a liveness probe runs where a secret should not
have to: a service manager, an uptime checker, a container orchestrator.

## Publishing

Anything you `POST` to `/:topic` becomes a message on that topic. The request body is
the message text, taken verbatim as UTF-8 — a JSON body is not reshaped.

```bash
curl -H "Authorization: Bearer $TOKEN" -d "hello" http://127.0.0.1:4500/mytopic
# {"id":"…","topic":"mytopic","title":null,"message":"hello","priority":3,"tags":[],"timestamp":1700000000}
```

Metadata travels in optional headers:

| Header       | Default | Meaning                                                                   |
| ------------ | ------- | ------------------------------------------------------------------------- |
| `X-Title`    | none    | Notification title, UTF-8, at most 256 bytes. Blank is treated as absent. |
| `X-Priority` | `3`     | Integer `1`–`5`. Anything else is rejected.                               |
| `X-Tags`     | none    | Up to 16 comma-separated UTF-8 tags of 64 bytes each; space is ignored.   |

```bash
curl -H "Authorization: Bearer $TOKEN" \
     -H "X-Title: Deploy finished" -H "X-Priority: 5" -H "X-Tags: ci,deploy" \
     -d "shipped" http://127.0.0.1:4500/mytopic
```

Topic names are 1–64 characters of `A-Z`, `a-z`, `0-9`, `-` or `_`. A message needs a
body or a title; an empty request with neither is rejected with `400`.

### Metadata size

`X-Title` and `X-Tags` are bounded like the body is, and for the same reason: a title is
one line on a lock screen, and nothing that long belongs there. Both are measured in
bytes, not characters. A title is measured exactly as it arrived, so padding a long one
with space does not buy it room; a tag is measured after the space around it is dropped,
so what is bounded is the tag a subscriber is actually sent. Over-long metadata is
rejected with `400` naming the rule, rather than truncated — half a title is not what the
sender asked to be shown:

```bash
curl -i -H "Authorization: Bearer $TOKEN" -H "X-Tags: $(printf 'a,%.0s' {1..17})" \
     -d "hello" http://127.0.0.1:4500/mytopic
# HTTP/1.1 400 Bad Request
# {"error":"X-Tags must be at most 16 tags of at most 64 bytes each"}
```

Empty tags are dropped before the count, so `ci,,deploy` is two tags.

Send each header once. A metadata header sent twice is folded into one comma-joined value
before the server sees it, so two `X-Title` headers make one title reading `alpha, beta`,
and two `X-Priority` headers make a value that is not an integer and is rejected. The size
limits are applied to the joined value, so repeating a header wins no extra room. A
repeated `Authorization` header is different again: the first is used and the rest are
discarded.

### Metadata encoding

`X-Title` and `X-Tags` are UTF-8. Send the bytes of the text you want shown — which is
what `curl` already does with a UTF-8 terminal — and no encoding scheme wraps them:

```bash
curl -H "Authorization: Bearer $TOKEN" -H "X-Title: Café déjà vu" \
     -d "hello" http://127.0.0.1:4500/mytopic
# {"id":"…","title":"Café déjà vu","message":"hello",…}
```

Bytes that are not UTF-8 are rejected with `400 {"error":"X-Title must be valid UTF-8"}`
(and the matching message for `X-Tags`), rather than delivered as whatever they happen to
spell in some other encoding. A title encoded latin1 — where `é` is the single byte
`0xE9` — is refused, because that same byte begins a character in UTF-8 and finishes
none: a server that guessed would quietly deliver the wrong title.

The size limits above are unaffected: they count the bytes that arrived, so a 256-byte
title is 256 ASCII characters, or 128 accented ones.

### Body size

A publish body is at most **4096 bytes** — bytes, not characters, so a multi-byte one
counts for what it weighs. A larger one is rejected with `413`:

```bash
curl -i -H "Authorization: Bearer $TOKEN" --data-binary @big.txt http://127.0.0.1:4500/mytopic
# HTTP/1.1 413 Payload Too Large
# {"error":"message body must be at most 4096 bytes"}
```

The check happens while the body is being read, which is before the token is looked at.
An over-long publish therefore hears `413` even with no credentials at all — the server
refuses to hold a large body for a client it has not yet authenticated. Nothing is
stored, nothing reaches subscribers, and the token is charged nothing against its
rate limit.

### Body encoding

The body is UTF-8, the same as `X-Title` and `X-Tags`: send the bytes of the message you
want delivered. Bytes that are not UTF-8 are rejected with `400` rather than delivered as
U+FFFD replacements — the body is the notification itself, so a mangled one is the wrong
notification:

```bash
curl -i -H "Authorization: Bearer $TOKEN" --data-binary $'Caf\xe9' http://127.0.0.1:4500/mytopic
# HTTP/1.1 400 Bad Request
# {"error":"message body must be valid UTF-8"}
```

Like the size check, this happens while the body is read: an ill-encoded publish is
refused before the token is looked at, and nothing is stored or delivered.

### Rate limit

A token may publish **60 times a minute**. The 61st is answered with `429` and a
`Retry-After` giving the whole seconds until a slot frees:

```bash
curl -i -H "Authorization: Bearer $TOKEN" -d "hello" http://127.0.0.1:4500/mytopic
# HTTP/1.1 429 Too Many Requests
# retry-after: 42
# {"error":"publish rate limit exceeded"}
```

The window slides, so the limit is 60 publishes in any 60 seconds rather than 60 per
clock minute — a client cannot spend its budget at the end of one minute and again at
the start of the next.

Every attempt that reaches the limiter is charged, including one the handler goes on to
reject with `400` — a malformed `X-Priority`, a reserved topic name: a publisher looping
on a malformed request is exactly the flood the limit exists to stop.

What is _not_ charged is a request turned away before the limiter, which runs just after
authentication. A request that fails to authenticate spends nothing — it named no token to
charge — and so does a body refused while it is read, before the token is looked at: an
over-long one (`413`) or one that is not UTF-8 (`400`), exactly as the size and encoding
sections above note. Each token has its own budget, so a noisy publisher cannot spend a
quiet one's.

Subscribing is not limited. A subscriber holds one long-lived connection, and the
reconnect it makes after a dropped one is the request it can least afford to have
refused.

## Subscribing

`GET /:topic/ws` upgrades to a WebSocket and pushes one JSON frame per message
published to that topic, for as long as the socket stays open:

```json
{
  "id": "1c2bada3-ff00-4cd5-8a4e-24d77b408fd1",
  "topic": "mytopic",
  "title": "Deploy finished",
  "message": "shipped",
  "priority": 5,
  "tags": ["ci", "deploy"],
  "timestamp": 1700000000
}
```

By default a subscriber sees only what is published while it is connected. Add
`?since=` to replay what it missed first (see [Catching up](#catching-up)).

Subscribing to a name that is not a valid topic closes the socket with code `1008`;
the close reason says which rule the request broke.

### Several topics over one connection

Name the topics separated by commas to receive all of them on a single socket:

```bash
# one connection, three topics
websocat "ws://127.0.0.1:4500/deploys,alerts,backups/ws?auth=$TOKEN"
```

Every frame carries its own `topic`, which is how a client tells the streams apart. A
topic named twice is still delivered once. At most 50 topics may share a connection,
and if any name in the list is invalid the whole subscription is refused — none of the
topics are attached.

### Without a WebSocket

`GET /:topic/json` carries the same messages as a newline-delimited JSON stream — one
message per line, written as it is published. The response stays open until the client
disconnects, so any HTTP client can subscribe:

```bash
curl -sN -H "Authorization: Bearer $TOKEN" http://127.0.0.1:4500/mytopic/json
# {"id":"…","topic":"mytopic","title":null,"message":"hello","priority":3,"tags":[],"timestamp":1700000000}
# {"id":"…","topic":"mytopic","title":null,"message":"there","priority":3,"tags":[],"timestamp":1700000005}
```

`curl` needs `-N` here: without it the output is buffered and nothing appears until the
stream ends. The stream honours `?since=` and multiplexes over a comma-separated list
exactly as the socket does:

```bash
curl -sN -H "Authorization: Bearer $TOKEN" http://127.0.0.1:4500/deploys,alerts/json
```

An invalid or over-long topic list is rejected with `400` before the stream opens.

### Catching up

Both subscribe routes take `?since=<unix_ts>`, a time in whole seconds since the Unix
epoch. Every stored message on the subscribed topics published at or after that second
is sent first, oldest first, and the live stream follows without a gap:

```bash
# everything on `deploys` since a given second, then whatever comes next
curl -sN -H "Authorization: Bearer $TOKEN" \
     "http://127.0.0.1:4500/deploys/json?since=1700000000"

# the whole retained backlog
curl -sN -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:4500/deploys/json?since=0"
```

A client that reconnects passes the `timestamp` of the last message it saw, and misses
nothing published while it was away. Omit `since` and nothing is replayed.

The bound is **inclusive**, because timestamps resolve to the whole second: a client
asking for everything since the last message it saw would otherwise lose one published
during that same second. A message may therefore arrive twice across a reconnect, so
clients de-duplicate on `id`, which is unique per message.

`since` must be a non-negative whole number. Anything else — a negative, a fraction, a
word, an empty value — is refused rather than silently ignored: on `/json` with `400`,
on `/ws` by closing the socket with `1008`. Replay reaches back only as far as the
messages the cache still holds.

### Keepalive

A topic can stay quiet for hours, and a connection with no traffic on it is one a
reverse proxy will eventually cut and a dead peer can hide behind. So the server
touches every subscriber every **45 seconds**:

- On a WebSocket it sends a ping frame. WebSocket libraries answer with a pong on
  their own, so a client normally needs no code for this. A subscriber that misses a
  whole interval without answering is assumed gone and its socket is closed, which is
  what frees the subscription server-side.
- On a `/:topic/json` stream, which has no ping frame of its own, it writes a blank
  line. Skip empty lines when reading the stream — `curl -sN … | jq -c` already does —
  and parse the rest as one message per line.

A client that has heard nothing at all for 90 seconds should assume the connection is
dead and reconnect.

### Slow subscribers

A subscriber that stops reading does not stop the messages published to its topics.
They queue in the server, so the server holds at most **1 MiB** for any one connection
and then drops it — a client on a bad link cannot grow the process without bound. A
dropped subscriber sees its WebSocket or stream close, and is free to reconnect.

Reading promptly is all a client has to do to stay under the limit: the queue drains
between messages and only a stalled connection ever accumulates.

## Message cache

Every accepted message is written to SQLite before it is handed to live subscribers, so
a message the server answered `200` for is one that outlives the process. The database
is the file named by `DB_PATH`, created on first run; a message rejected with `400` is
never stored.

The cache is what lets a subscriber that was offline — or whose socket dropped — catch
up on what it missed: `?since=` on either subscribe route reads it back (see
[Catching up](#catching-up)).

### Retention

A cached message expires after `RETENTION_HOURS` (**72** by default). Expired messages
are swept out of the database when the server starts and once an hour after that, so the
file stays bounded by how much you publish in a window rather than growing forever.

The window is also the limit on `?since=`: a subscriber that reconnects after longer
than `RETENTION_HOURS` away has lost what it missed, and starts from what is left.
Set the window to however long you expect a subscriber to be able to stay offline.

The sweep runs at startup as well as hourly, so a server that was down while messages
expired does not serve them on the way back up.

## Configuration

Configuration comes from the process environment. On start the server also loads a `.env`
file from its working directory, so [`.env.example`](./.env.example) can be copied to
`.env` and picked up; a real environment variable still wins, so a service manager (see
[`../deploy/`](../deploy/)) or a one-off `PORT=… pnpm start` overrides a file value. The
file is `KEY=value` lines, with `#` comments on their own line; a line it cannot read, or
one that sets the same key twice, refuses to start naming the line rather than guessing at
which value was meant.

| Variable          | Default             | Meaning                                      |
| ----------------- | ------------------- | -------------------------------------------- |
| `PORT`            | `4500`              | Port to listen on.                           |
| `HOST`            | `127.0.0.1`         | Interface to bind.                           |
| `DB_PATH`         | `./commlink.sqlite` | SQLite database: messages, tokens.           |
| `RETENTION_HOURS` | `72`                | How long cached messages are kept, in hours. |
| `LOG_LEVEL`       | `info`              | Log verbosity, or `silent` to turn it off.   |

`RETENTION_HOURS` must be a whole number of hours, at least `1`. The server refuses to
start on anything else rather than run with a window that would never expire a message.

`LOG_LEVEL` is one of `trace`, `debug`, `info`, `warn`, `error`, `fatal`, or `silent`, and
an unknown value refuses to start the same way. Logs are structured JSON on stdout. A
subscribe token passed as `?auth=<token>` is redacted from the request line before the
server logs it, so it does not reach the server's own log. A reverse proxy in front is a
separate matter: `?auth=` rides in the URL, and a proxy's access log records the request
line as it arrived — nginx's default format logs the full URI, query string and all — so
the token lands there in clear unless the proxy is told not to log it. See
[`../deploy/`](../deploy/) for how to keep it out of the proxy's log.

The server binds loopback by default. To expose it, put it behind a TLS reverse proxy —
see [`../deploy/`](../deploy/) — or set `HOST` to a specific address on a trusted network.
A blank `HOST` refuses to start rather than fall through to binding every interface, which
is how an empty value would otherwise reach `listen`.

`DB_PATH` may be a file path or the literal `:memory:` for a deliberately ephemeral server.
A blank value refuses to start: SQLite opens an empty filename as a private temporary
database that is deleted on close — and the messages and tokens hold separate connections,
so a blank path would silently give each its own throwaway database, persisting nothing and
authorizing nobody.

## API

| Method | Path            | Auth             | Purpose                        |
| ------ | --------------- | ---------------- | ------------------------------ |
| `GET`  | `/healthz`      | none             | Liveness probe (200 + uptime). |
| `POST` | `/:topic`       | header           | Publish a message to a topic.  |
| `GET`  | `/:topics/ws`   | header, `?auth=` | Subscribe over WebSocket.      |
| `GET`  | `/:topics/json` | header, `?auth=` | Subscribe over plain HTTP.     |

All four are available now. Both subscribe routes take one topic or a comma-separated
list of them, and both accept `?since=<unix_ts>` to replay the cache before streaming
live messages. "header" is `Authorization: Bearer <token>`; see
[Authentication](#authentication). Publishing is capped at 60 requests a minute per
token (see [Rate limit](#rate-limit)) and 4096 bytes per body (see
[Body size](#body-size)); the other three routes are uncapped.

Every refusal answers with the same JSON shape — `{"error":"<reason>"}` — including an
unknown path or an unsupported method, which return `404 {"error":"not found"}`. A client
can read the reason off `error` on any response it did not expect.

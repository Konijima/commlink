# commlink server

The pub/sub push-notification server: Node.js + TypeScript, Fastify, WebSocket, and
SQLite. It accepts published messages over HTTP and streams them to subscribed clients
over WebSocket.

> Early development. Publishing, both subscribe routes and the message cache are live.
> Replaying the cache to a reconnecting subscriber, and auth, are still being built —
> see [`../TODO.md`](../TODO.md).

## Requirements

- Node.js 20+
- [pnpm](https://pnpm.io)

The SQLite driver ships prebuilt binaries for common platforms. On anything else it is
compiled during install, which needs a C++ toolchain.

## Development

```bash
pnpm install
pnpm test          # vitest
pnpm typecheck     # tsc --noEmit
pnpm dev           # start on http://127.0.0.1:4500
```

```bash
curl http://127.0.0.1:4500/healthz
# {"status":"ok","uptime":12.34}
```

## Publishing

Anything you `POST` to `/:topic` becomes a message on that topic. The request body is
the message text, taken verbatim — a JSON body is not reshaped.

```bash
curl -d "hello" http://127.0.0.1:4500/mytopic
# {"id":"…","topic":"mytopic","title":null,"message":"hello","priority":3,"tags":[],"timestamp":1700000000}
```

Metadata travels in optional headers:

| Header       | Default | Meaning                                                   |
| ------------ | ------- | --------------------------------------------------------- |
| `X-Title`    | none    | Notification title. Blank is treated as absent.           |
| `X-Priority` | `3`     | Integer `1`–`5`. Anything else is rejected.               |
| `X-Tags`     | none    | Comma-separated tags; surrounding space is ignored.       |

```bash
curl -H "X-Title: Deploy finished" -H "X-Priority: 5" -H "X-Tags: ci,deploy" \
     -d "shipped" http://127.0.0.1:4500/mytopic
```

Topic names are 1–64 characters of `A-Z`, `a-z`, `0-9`, `-` or `_`. A message needs a
body or a title; an empty request with neither is rejected with `400`.

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

Subscribers are live-only: every message is stored (see [Message cache](#message-cache)),
but nothing is replayed on connect yet. `?since=` replay is next on the roadmap.

Subscribing to a name that is not a valid topic closes the socket with code `1008`;
the close reason says which rule the request broke.

### Several topics over one connection

Name the topics separated by commas to receive all of them on a single socket:

```bash
# one connection, three topics
websocat ws://127.0.0.1:4500/deploys,alerts,backups/ws
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
curl -sN http://127.0.0.1:4500/mytopic/json
# {"id":"…","topic":"mytopic","title":null,"message":"hello","priority":3,"tags":[],"timestamp":1700000000}
# {"id":"…","topic":"mytopic","title":null,"message":"there","priority":3,"tags":[],"timestamp":1700000005}
```

`curl` needs `-N` here: without it the output is buffered and nothing appears until the
stream ends. The stream is live-only, exactly like the socket, and multiplexes over a
comma-separated list the same way:

```bash
curl -sN http://127.0.0.1:4500/deploys,alerts/json
```

An invalid or over-long topic list is rejected with `400` before the stream opens.

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

The cache is what will let a subscriber that was offline — or whose socket dropped —
catch up on what it missed. The `?since=` parameter that exposes it on the subscribe
routes is not implemented yet, so today the cache is written but not read back. Nothing
is deleted yet either; retention lands with it.

Timestamps resolve to the whole second, so replay will be inclusive of the second a
client last saw and messages can arrive twice across a reconnect. Clients should
de-duplicate on `id`, which is unique per message.

## Configuration

Configuration comes from the process environment. A `.env` file is **not** loaded yet, so
set the variables in the shell or in your service manager (see
[`../deploy/`](../deploy/)); [`.env.example`](./.env.example) previews the full set.

| Variable          | Default              | Meaning                            | Status     |
| ----------------- | -------------------- | ---------------------------------- | ---------- |
| `PORT`            | `4500`               | Port to listen on.                 | Read now   |
| `HOST`            | `127.0.0.1`          | Interface to bind.                 | Read now   |
| `DB_PATH`         | `./commlink.sqlite`  | SQLite database file.              | Read now   |
| `RETENTION_HOURS` | `72`                 | How long cached messages are kept. | Not yet    |

`RETENTION_HOURS` lands with retention; setting it today has no effect.

The server binds loopback by default. To expose it, put it behind a TLS reverse proxy —
see [`../deploy/`](../deploy/).

## API

| Method | Path                     | Purpose                                            |
| ------ | ------------------------ | -------------------------------------------------- |
| `GET`  | `/healthz`               | Liveness probe (200 + uptime). **Available now.**  |
| `POST` | `/:topic`                | Publish a message to a topic. **Available now.**   |
| `GET`  | `/:topics/ws`            | Subscribe over WebSocket. **Available now.**       |
| `GET`  | `/:topics/json`          | Subscribe over plain HTTP. **Available now.**      |

Both subscribe routes take one topic or a comma-separated list of them. Published
messages are cached, but they still fan out to live subscribers only — there is no way
to ask for a replay yet, and no endpoint requires a bearer token yet.

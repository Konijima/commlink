# commlink server

The pub/sub push-notification server: Node.js + TypeScript, Fastify, WebSocket, and
SQLite. It accepts published messages over HTTP and streams them to subscribed clients
over WebSocket, caching everything so nothing is lost across reconnects.

> Early development. Publishing is live; subscribers, the message cache and auth are
> being built — see [`../TODO.md`](../TODO.md).

## Requirements

- Node.js 20+
- [pnpm](https://pnpm.io)

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

## Configuration

Configuration comes from the environment (a local `.env` is loaded in development; see
[`.env.example`](./.env.example)):

| Variable          | Default              | Meaning                              |
| ----------------- | -------------------- | ------------------------------------ |
| `PORT`            | `4500`               | Port to listen on.                   |
| `HOST`            | `127.0.0.1`          | Interface to bind.                   |
| `DB_PATH`         | `./commlink.sqlite`  | SQLite database file.                |
| `RETENTION_HOURS` | `72`                 | How long cached messages are kept.   |

The server binds loopback by default. To expose it, put it behind a TLS reverse proxy —
see [`../deploy/`](../deploy/).

## API

| Method | Path                     | Purpose                                            |
| ------ | ------------------------ | -------------------------------------------------- |
| `GET`  | `/healthz`               | Liveness probe (200 + uptime). **Available now.**  |
| `POST` | `/:topic`                | Publish a message to a topic. **Available now.**   |
| `GET`  | `/:topic/ws`             | Subscribe over WebSocket (multiplexed, `,`-joined).|
| `GET`  | `/:topic/json`           | HTTP long-poll / SSE fallback.                     |

Published messages currently fan out to live subscribers only; they are not yet cached
or replayed, and neither endpoint requires a bearer token yet. Both are on the roadmap.

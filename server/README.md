# commlink server

The pub/sub push-notification server: Node.js + TypeScript, Fastify, WebSocket, and
SQLite. It accepts published messages over HTTP and streams them to subscribed clients
over WebSocket, caching everything so nothing is lost across reconnects.

> Early development. `GET /healthz` is live; the publish/subscribe API is being built —
> see [`../TODO.md`](../TODO.md).

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

## API (planned)

| Method | Path                     | Purpose                                            |
| ------ | ------------------------ | -------------------------------------------------- |
| `GET`  | `/healthz`               | Liveness probe (200 + uptime). **Available now.**  |
| `POST` | `/:topic`                | Publish a message to a topic.                      |
| `GET`  | `/:topic/ws`             | Subscribe over WebSocket (multiplexed, `,`-joined).|
| `GET`  | `/:topic/json`           | HTTP long-poll / SSE fallback.                     |

Publish and subscribe will require a bearer token; see the roadmap for details.

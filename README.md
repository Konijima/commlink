# commlink

**Self-hosted push notifications you fully own.** commlink is a tiny publish/subscribe
server and a native Android client that deliver push notifications to your phone
without Google, Firebase, or FCM anywhere in the path. Publish a message with a plain
`curl`, and your device shows a notification seconds later.

It is inspired by the architecture of [ntfy](https://ntfy.sh), kept deliberately
minimal, and built to run on hardware you control.

```
curl -H "Authorization: Bearer $TOKEN" -d "Backup finished" https://your-server/backups
```

> **Status:** early development. The server and app are being built in the open; see
> [`TODO.md`](./TODO.md) for the roadmap and [`BUGS.md`](./BUGS.md) for known issues.

## Why commlink

- **No proprietary dependencies.** No Google Play Services, no Firebase, no FCM. The
  Android app builds from an AOSP-compatible toolchain and talks straight to your server.
- **You host it.** One small Node.js process and a SQLite file. Put it behind any TLS
  reverse proxy.
- **Simple to publish.** Any HTTP client works: `curl`, a cron job, a shell script,
  a webhook.
- **Closed by default.** Publishing and subscribing both need a bearer token you mint
  yourself. A server with no tokens minted authorizes nobody.
- **Reliable delivery.** Every message is stored server-side, and a subscriber that
  reconnects with `?since=<unix_ts>` is sent what it missed, so a flaky connection does
  not lose a notification. Messages are kept for 72 hours and then swept, so the
  database stays bounded.

## How it works

```
publisher ──HTTP POST──►  commlink server  ──WebSocket──►  Android app  ──►  notification
                          (Fastify + SQLite)
```

- **Publish:** `POST /:topic` with a text or JSON body. Optional headers set the title,
  priority, and tags.
- **Subscribe:** the app holds a single multiplexed WebSocket for all its topics and
  turns each incoming message into a system notification.
- **Never miss a message:** every message is stored, and a subscriber that reconnects
  with `?since=<unix_ts>` is sent what it missed before the live stream resumes. The
  Android client will use this on every reconnect.

## Components

| Directory  | What it is                                                             |
| ---------- | --------------------------------------------------------------------- |
| `server/`  | The pub/sub server — Node.js + TypeScript, Fastify, WebSocket, SQLite. |
| `android/` | The native Android client — Kotlin, Jetpack Compose, OkHttp, Room.     |
| `deploy/`  | Generic deployment notes: a systemd unit and a TLS reverse-proxy snippet. |

## Quick start (server)

Requirements: Node.js 22+ and [pnpm](https://pnpm.io).

```bash
cd server
pnpm install
pnpm test                     # run the test suite
TOKEN=$(pnpm --silent token:create me)   # mint a token; it is shown once
pnpm dev                      # start the server on http://127.0.0.1:4500
```

Check it is alive, then publish a message:

```bash
curl http://127.0.0.1:4500/healthz
curl -H "Authorization: Bearer $TOKEN" -d "hello" http://127.0.0.1:4500/mytopic
```

See [`server/README.md`](./server/README.md) for configuration and the full API, and
[`android/README.md`](./android/README.md) for building the app.

## License

[MIT](./LICENSE) © Konijima

# Roadmap

The plan for building commlink, roughly in order. Checkboxes: `[ ]` todo, `[~]` in
progress, `[x]` done. The server comes first and is verified end-to-end with `curl`
before the Android client is built against it.

## Done

- [x] Repository scaffold: pnpm/TypeScript server project, Android placeholder, CI.
- [x] Server `GET /healthz` returning `200` with process uptime, plus a smoke test.
- [x] `POST /:topic` — publish a text or JSON body to a topic. Optional headers:
      `X-Title`, `X-Priority` (1–5, default 3), `X-Tags` (comma-separated). Works
      with a bare `curl -d "hello" https://server/mytopic`. Messages fan out to live
      subscribers through an in-memory broker.
- [x] `GET /:topic/ws` — upgrade to WebSocket and push each new message as a JSON frame
      `{ id, topic, title, message, priority, tags, timestamp }`. Live-only for now;
      an invalid topic closes the socket with `1008`.
- [x] `GET /:topic/json` — the same stream over plain HTTP, as newline-delimited JSON,
      for clients that cannot open a WebSocket. Live-only; an invalid topic gets `400`.
- [x] Multiplexed subscribe: `GET /:topic1,topic2,topic3/ws` over one connection, and
      the same on `/json`. Up to 50 topics; each frame names its own topic. One bad
      name refuses the whole subscription.
- [x] Keepalive every 45s: a ping frame on a WebSocket, a blank line on a `/json`
      stream. A subscriber that misses a ping is dropped, so a dead connection stops
      holding a subscription open.

## Server (v0.1)

The self-hostable pub/sub core.

### Publish & subscribe
- [ ] Handle a subscriber that stops reading. Both subscribe routes write without
      checking backpressure, so a stalled client makes the server buffer without bound.
      Watch the socket's `bufferedAmount` (and `write()`'s return value on the NDJSON
      stream), then drop the slowest consumers rather than growing the heap.

### Message cache & replay
- [ ] Persist every message to SQLite.
- [ ] `?since=<unix_ts>` on subscribe replays missed messages before streaming live ones.
- [ ] Retention: 72h, cleaned by an hourly job.

### Auth & safety
- [ ] Bearer-token auth on **both** publish and subscribe (`Authorization: Bearer …`,
      or `?auth=` query param for WebSocket clients).
- [ ] `tokens` table in SQLite; a `pnpm token:create <name>` CLI mints tokens.
- [ ] Rate limit: 60 requests/min per token on publish.
- [ ] Reject payloads larger than 4 KB.

### Ops
- [ ] Graceful shutdown on `SIGTERM`/`SIGINT`: stop accepting, end the open subscriber
      streams, then exit. Today the process is killed outright, so a restart drops
      subscribers without closing their connections.
- [ ] Config via `.env`: `PORT`, `DB_PATH`, `RETENTION_HOURS`. Nothing reads a `.env`
      file today — only `PORT` and `HOST`, straight from the process environment.
- [ ] Lint and format: no linter or formatter is configured, so `CONTRIBUTING.md` cannot
      point contributors at one and CI checks only types and tests. Add ESLint and
      Prettier, a `lint` script, and a CI step that runs it.
- [ ] Structured logging with pino.
- [ ] Test suite (vitest): publish→subscribe roundtrip, replay-since, auth rejection,
      rate limit.
- [ ] `deploy/`: a systemd unit and a TLS reverse-proxy (Caddy) snippet.

## Android app (v0.2)

Native Kotlin client, min SDK 26, Jetpack Compose, no Google Play Services.

### Connection service
- [ ] `SubscriberService` — a `START_STICKY` foreground service holding one multiplexed
      WebSocket for all subscribed topics, with a persistent low-priority notification.
- [ ] Reconnect with exponential backoff (1s → 2s → 4s … cap 5 min) plus jitter;
      reconnect immediately on network-change callbacks.
- [ ] On reconnect, request replay with `?since=<last_seen_timestamp>` so nothing is lost.
- [ ] Send pong responses; force-reconnect if no server ping arrives for 90s.
- [ ] Boot receiver restarts the service after reboot (`RECEIVE_BOOT_COMPLETED`).
- [ ] First-launch prompt to exempt the app from battery optimization, with an
      explanation screen.

### Notifications
- [ ] One notification channel per priority (min/low/default/high/urgent) so per-priority
      sound/vibration is configurable in system settings.
- [ ] Priority 5 → high-importance heads-up; priority 1–2 → silent.
- [ ] Tapping a notification opens that topic's message list in-app.

### UI (Compose, dark theme)
- [ ] Topics screen: subscribed topics with unread badges; FAB to add a topic.
- [ ] Messages screen: reverse-chronological messages with title/body/tags/time.
- [ ] Settings screen: server URL, auth token, connection status, battery-exemption
      status, and a "test notification" button.
- [ ] Persist topics and messages in Room; cap 500 messages per topic locally.

### Build & distribution
- [ ] `./gradlew assembleRelease` produces a signed APK; document keystore creation.
- [ ] Sideload-only: signing config via `keystore.properties` (gitignored).

## Ideas / later

- [ ] Optional message attachments.
- [ ] Web subscriber for the browser.
- [ ] Per-topic access scopes on tokens.

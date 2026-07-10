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
- [x] Handle a subscriber that stops reading. The server holds at most 1 MiB of queued
      messages for any one connection and drops it past that, so a stalled client can
      no longer grow the heap without bound.
- [x] Persist every message to SQLite, at `DB_PATH`, before it is fanned out to live
      subscribers.
- [x] `?since=<unix_ts>` on subscribe replays missed messages before streaming live ones,
      on both `/ws` and `/json`. The bound is inclusive to the second, so a reconnecting
      client can see one message twice and de-duplicates on `id`. A malformed `since` is
      rejected rather than ignored.
- [x] Retention: messages expire after `RETENTION_HOURS` (72 by default), swept at startup
      and hourly after. The window bounds both the database and how far `?since=` can
      replay. A `RETENTION_HOURS` that is not a whole number of hours refuses to start,
      rather than silently expiring nothing.
- [x] Bearer-token auth on **both** publish and subscribe (`Authorization: Bearer …`, or
      `?auth=` on the subscribe routes, which is the only way a browser can authenticate
      a WebSocket). Publish takes the header only, since a query string is what proxies
      and access logs write down. `/healthz` stays open. A server whose database holds no
      tokens authorizes nobody.
- [x] `tokens` table in SQLite, storing only a SHA-256 of each token; a
      `pnpm token:create <name>` CLI mints them and prints each one once.
- [x] Manage minted tokens without editing the database by hand: `pnpm token:list` shows
      the id, name and minting time of each (never the token or its hash), and
      `pnpm token:revoke <name>` deletes one. A revoked token is refused from the next
      request onward, with no restart; revoking a name that was never minted is an error
      rather than a no-op. The name is free to mint again, and the replacement gets a new
      id, so it does not inherit the revoked token's spent rate-limit budget.
- [x] Rate limit: 60 publishes per minute per token, over a sliding window, answered with
      `429` and a `Retry-After`. Every attempt is charged, including one the handler goes
      on to reject; a request that never authenticated is not. Subscribing is uncapped.
- [x] Reject publish bodies larger than 4096 bytes with `413`. The limit is counted in
      bytes and enforced while the body is read — before the token is checked — so an
      unauthenticated client can no longer make the server hold a large body.
- [x] Bound the publish metadata headers: `X-Title` to 256 bytes, `X-Tags` to 16 tags of
      64 bytes each. Both are measured in the bytes that arrived, and an over-long one is
      rejected with `400` naming the rule rather than silently truncated.
- [x] Read `X-Title` and `X-Tags` as UTF-8 (`BUGS.md#2`), so an accented title is stored and
      delivered as it was sent. The headers carry raw UTF-8 bytes — no RFC 2047 encoding —
      and bytes that are not UTF-8 are rejected with `400` naming the rule. The byte limits
      are unchanged, since decoding is lossless.

## Server (v0.1)

The self-hostable pub/sub core.

### Fix first

- [ ] Make the backpressure suite deterministic (`BUGS.md#4`). One test predicts how many
      messages fill a second connection from what filled a first, and the kernel does not
      buffer two sockets alike — so the suite is intermittently red, and green does not
      always mean the behaviour was exercised. Until it is fixed a failing run cannot be
      told apart from a real regression, which makes it worth more than any feature below.

### Auth & safety
- [ ] Disconnect a subscriber whose token is revoked. A token is checked when a
      connection is made, not while it is held, so a revoked subscriber keeps its open
      stream until it reconnects. Restarting the server is the only way to cut one off
      today, which is documented but blunt.
- [ ] Decide whether the publish rate limit needs to outlive the process. It is counted
      in memory, so a restart hands every token a fresh budget, and two server processes
      sharing a database would each grant the full 60. Neither matters to a single
      self-hosted server, which is the only way it runs today.

### Ops
- [ ] Graceful shutdown on `SIGTERM`/`SIGINT`: stop accepting, end the open subscriber
      streams, then exit. Today the process is killed outright, so a restart drops
      subscribers without closing their connections.
- [ ] Config via `.env`: nothing reads a `.env` file today. `PORT`, `HOST`, `DB_PATH` and
      `RETENTION_HOURS` are read straight from the process environment, so `.env.example`
      cannot be copied to `.env` and picked up.
- [ ] Lint and format: no linter or formatter is configured, so `CONTRIBUTING.md` cannot
      point contributors at one and CI checks only types and tests. Add ESLint and
      Prettier, a `lint` script, and a CI step that runs it.
- [ ] Structured logging with pino.
- [x] Test suite (vitest): publish→subscribe roundtrip, replay-since, auth rejection,
      rate limit.
- [x] CI builds the server and boots the built output (`pnpm smoke`). It ran only
      `typecheck` and `test`, which is why `BUGS.md#1` — the built server cannot start —
      went unnoticed: both `pnpm dev` and the tests resolve imports the built output cannot.
- [ ] Cover the gap where `?since=` replay meets the per-connection buffer limit. A
      replayed backlog is written through the same path as a live message, so a large
      replay to a slow subscriber can drop the connection mid-replay. The behaviour is
      unpinned by any test.
- [ ] Cover who owns a store: the app closes a message store or a token store it created
      itself, and leaves an injected one open. Nothing tests either half for either store,
      and closing a database twice is a no-op, so a regression would pass the suite.
- [ ] Cover the refusal to start on a malformed `RETENTION_HOURS`. The parser and the app
      builder each reject one, but nothing runs the server as a process and asserts it
      exits non-zero with the reason on stderr — which is the behaviour an operator with a
      bad config actually meets.
- [ ] Test on the Node.js versions the docs promise. The READMEs say Node 20+, CI runs
      Node 22 only.
- [ ] `deploy/`: a systemd unit and a TLS reverse-proxy (Caddy) snippet. Both files
      exist and the built server now starts (`BUGS.md#1`), but the unit stays unchecked
      until it has been run end-to-end.

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
      status, and a "test notification" button. The token goes on every subscribe, as
      `Authorization: Bearer …` on the WebSocket handshake.
- [ ] Persist topics and messages in Room; cap 500 messages per topic locally.

### Build & distribution
- [ ] `./gradlew assembleRelease` produces a signed APK; document keystore creation.
- [ ] Sideload-only: signing config via `keystore.properties` (gitignored).

## Ideas / later

- [ ] Optional message attachments.
- [ ] Web subscriber for the browser.
- [ ] Per-topic access scopes on tokens.

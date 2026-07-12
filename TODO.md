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
- [x] Make the backpressure suite deterministic (`BUGS.md#4`). The test that covers dropping
      a stalled reader now watches the backlog the server actually holds, rather than
      predicting it from how many messages filled an earlier connection — two sockets are
      not buffered alike. It fails if a message delivery drops the reader first, so a green
      run means the keepalive did the work the test names.
- [x] Read `X-Title` and `X-Tags` as UTF-8 (`BUGS.md#2`), so an accented title is stored and
      delivered as it was sent. The headers carry raw UTF-8 bytes — no RFC 2047 encoding —
      and bytes that are not UTF-8 are rejected with `400` naming the rule. The byte limits
      are unchanged, since decoding is lossless.
- [x] Refuse a reserved topic name with its own reason (`BUGS.md#3`). `healthz` satisfies the
      topic alphabet but collides with the path the server serves itself, and used to be
      refused with the alphabet rule — a rule it does not break. Topic validation now reports
      *why* a name is refused, so a reserved name is named as reserved on publish (`400`), on
      the `/json` stream (`400`) and on the `/ws` upgrade (close `1008`) alike, while a
      bad-alphabet name still cites the alphabet. The alphabet is checked first, so an
      over-long name never reaches the reserved message.
- [x] Reject a publish body that is not UTF-8 with `400`, the same rule `X-Title` and
      `X-Tags` already keep. The body is the message text a subscriber is shown, but was
      read with a lossy decode that mapped an invalid byte to a U+FFFD replacement and
      delivered the mangled result silently — the header bug (`BUGS.md#2`) in a quieter
      place. It is now decoded strictly while the body is read, before the token is
      checked (like the size limit), so a non-UTF-8 body is refused naming the rule and is
      never stored or delivered, while an accented body round-trips unchanged.

## Server (v0.1)

The self-hostable pub/sub core. **Complete.** It publishes, fans out over both transports,
replays, authenticates, rate-limits and expires; the suite is green and the built server runs
under the shipped unit. The two items left open below are **deferred** — each says why — and
neither blocks the Android client, which is the next thing to build. A regression or a security
bug in the server still outranks everything; a further docs nit does not.

### Docs & deployment accuracy
- [x] Split the `log_format` snippet in `deploy/nginx.conf` so it can be uncommented where it is
      written (`BUGS.md#26`). `log_format` is an `http`-context directive that sat inside
      `location /`, so an operator following the comment — the one remedy offered for keeping a
      `?auth=` token out of the proxy log — got `nginx: [emerg] … not allowed here` and no proxy
      at all. The definition now sits at the file's top level (the `http` context), beside the
      `map` block and carrying the same note about why it cannot live deeper; only the
      `access_log` that names the format stays in the location, where it is legal and covers the
      routes whose URL carries the token. `test/deploynginx.test.ts` parses the shipped config
      and refuses an http-only directive inside a `server` or `location` — commented or live,
      since a commented directive is uncommented verbatim — and refuses an `access_log` naming a
      format the file does not define, which is the same dead proxy from the other half alone.
- [x] Settle whether `?auth=` authenticates a `HEAD` of the `/json` stream (`BUGS.md#27`). It
      authenticated a `GET` of the same URL but not a `HEAD`, because the check keyed on the
      method under the reasoning that subscribing is exactly the `GET` routes — which stopped
      being true when the stream gained a `HEAD`. Settled that it does: the rule is now keyed on
      the **route**, so the two subscribe routes take the query token whatever method they are
      asked with, which is what the docs already promised ("both subscribe *routes*") and what
      the method test was always standing in for. It expands nothing — the same token in the same
      URL already opens the full stream on a `GET`, so a `HEAD` of it grants strictly less — and
      it cannot go stale again the next time a subscribe route gains a method. Publishing stays
      header-only. An unmatched path now takes no query token either, since `?auth=` is a
      credential of the routes that document it, not of any URL a client can type.
- [x] Replace the `%h` paths in the systemd unit for the system-unit path, and correct the
      guide that says they follow `User=` (`BUGS.md#25`). They follow the service *manager*, so
      a system unit run as a dedicated account looked for the checkout in `/root` and never
      started. The unit now ships absolute paths — in the commented `EnvironmentFile` example
      too, which an operator uncomments verbatim — and the guide states the rule rather than the
      claim that broke it. `%S` stays: it is manager-scoped the same way, but `/var/lib` and
      `$XDG_STATE_HOME` are the right state root for each manager, so it needs no adjusting.
      `test/deployunit.test.ts` refuses a `%h` in any directive of the shipped unit, so the trap
      cannot creep back in.
- [x] Point an operator at the database the server actually reads (`BUGS.md#24`). The startup
      warning named the bare `pnpm token:create <name>`, which under the shipped unit mints into
      the checkout rather than the unit's `DB_PATH` — the same "authorizes nobody" outcome as the
      two footguns before it. The token store now knows the file it opened, so the warning names
      that database and mints against it by name (`DB_PATH=… pnpm token:create <name>`), which is
      right wherever the operator runs it; `token:list` suggests the same form. The commands also
      opened the store outside their own error handling, so a `DB_PATH` whose directory does not
      exist — every path before the first start, since the unit's `StateDirectory=` creates it *at*
      first start — threw a stack trace naming neither the command nor the setting; they now refuse
      in their own voice and name `DB_PATH`. The deploy guide says to start the service, then mint.
### Auth & safety
- [x] Disconnect a subscriber whose token is revoked. A connection is authenticated
      once, at the upgrade, so a revoked subscriber used to keep its open stream until it
      reconnected. The keepalive sweep now re-checks each open subscriber's token against
      the store and drops one whose token has gone — within a keepalive interval of the
      revoke, on both `/ws` (closed `1008 "token revoked"`) and `/json` (the response is
      ended). No restart, no held token: the connection is dropped by the id it resolved
      at connect time, and a name minted again gets a fresh id so no dropped subscriber is
      silently re-authorized.
- [x] Decide whether the publish rate limit needs to outlive the process. Settled that it
      does not: the window stays in memory, per process, on purpose. A restart hands every
      token a fresh budget and two processes sharing a database would each grant the full
      60, but the cap exists to stop a runaway publisher drowning subscribers, not to meter
      a quota that must survive a reboot — and a single self-hosted server is the only way
      it runs. Persisting it would put a shared store on the publish hot path to buy a
      guarantee nothing here needs. The deliberate choice is documented at the limiter and
      pinned by a test, so persisting or sharing the budget later has to be a conscious
      change rather than a silent regression.

### Ops
- [x] Graceful shutdown on `SIGTERM`/`SIGINT`: stop accepting, end the open subscriber
      streams, then exit `0`. The signal now closes the server rather than killing the
      process outright, so a WebSocket subscriber gets a close frame and a `/json` reader
      gets its response ended — each learns to reconnect instead of discovering the drop
      by its own timeout. A close that wedges is abandoned after 10s with a non-zero exit,
      and a second signal mid-shutdown is ignored rather than restarting the close.
- [x] Config via `.env`: the server loads a `.env` from its working directory on start, so
      `.env.example` can be copied to `.env` and picked up. A real environment variable
      still wins, so a service manager or a one-off `PORT=… pnpm start` overrides a file
      value; a missing file reads straight from the environment as before; a malformed one
      aborts the boot naming the line, rather than running on a default the operator meant
      to change. Comments are whole-line and a value may be quoted to keep spaces or a `#`.
- [x] Validate `PORT` at startup the way `RETENTION_HOURS` and `LOG_LEVEL` are. A bad
      value (`abc`, `8080.5`, `-1`, `65536`) used to be handed straight to `listen`, which
      failed with an `ERR_SOCKET_BAD_PORT` stack trace that named no setting and only after
      the database had already been opened. The server now refuses a `PORT` outside 0–65535
      (0 still asks the OS for a free port) before any side effect, tagging the reason on
      stderr so an operator learns which setting to fix.
- [x] Lint and format: ESLint (typescript-eslint) and Prettier are configured, with a
      `pnpm lint` script (ESLint + `prettier --check`) and a `pnpm format` script. CI runs
      `pnpm -r lint`, and `CONTRIBUTING.md` points contributors at both.
- [x] Structured logging with pino. The server logs JSON on stdout through Fastify's
      built-in logger, with `LOG_LEVEL` (`trace`…`fatal`, or `silent`) selecting verbosity
      and an unknown level refusing to start rather than running where it was. A subscribe
      token passed as `?auth=` rides in the URL, which the request log records, so the
      token is redacted from the logged line — the one place it could otherwise leak.
- [x] Test suite (vitest): publish→subscribe roundtrip, replay-since, auth rejection,
      rate limit.
- [x] CI builds the server and boots the built output (`pnpm smoke`). It ran only
      `typecheck` and `test`, which is why `BUGS.md#1` — the built server cannot start —
      went unnoticed: both `pnpm dev` and the tests resolve imports the built output cannot.
- [x] Cover the gap where `?since=` replay meets the per-connection buffer limit. A
      replayed backlog is written through the same path as a live message, so a replay
      too large to hand a subscriber that is not keeping up now provably drops it
      partway through rather than growing the heap without bound — on both `/ws` and
      `/json` — while a reader that drains still gets the whole backlog. Pinned by
      `test/replay-backpressure.test.ts`, and verified by mutation: removing the drop
      check fails both drop tests.
- [x] Cover who owns a store: the app closes a message store or a token store it created
      itself, and leaves an injected one open. `test/ownership.test.ts` pins both halves
      for both stores. Counting closes alone could not catch a regression — closing a
      database twice is a no-op — so the injected halves assert the store still answers a
      query after the app is gone, which a closed connection cannot. Verified by mutation:
      dropping the ownership guard so the app always closes the store fails the injected
      message-store case.
- [x] Cover the refusal to start on a malformed `RETENTION_HOURS`. The parser and the app
      builder each reject one; now `test/startup.test.ts` runs the entrypoint as its own
      process and asserts it exits non-zero with the reason tagged on stderr — the
      behaviour an operator with a bad config actually meets — for zero, a fraction, `1e3`,
      `0x10`, a non-number and blank. A valid window paired with a bad `LOG_LEVEL` proves
      the retention gate lets a good value through rather than refusing everything, and the
      refusals all exit before a port is bound.
- [x] Test on the Node.js versions the docs promise. CI now runs the full suite (typecheck,
      lint, test, build, boot) on a matrix rather than one version, with `fail-fast` off so
      one version's failure cannot mask another's. Adding Node 20 to the matrix surfaced that
      the docs promised a floor the toolchain cannot meet: the pinned pnpm refuses to run on
      anything below Node 22.13, so `pnpm install` fails outright on Node 20 and the "Node 20+"
      requirement was never true. Corrected the floor to Node 22 in the READMEs, `CONTRIBUTING`
      and `engines`; the matrix pins 22 (the real floor) and 24 (the current LTS). A single
      matrix-independent `verify` job gates on all legs, so branch protection keeps one stable
      required check as versions come and go.
### Deferred

Open, not dropped. Neither blocks the Android client, and both are cheap to pick up later.

- [ ] Correct the status codes the subscribe docs promise for an over-long topic list
      (`BUGS.md#23`): it is a `414` from the router, not the route's `400`, and on the socket
      it arrives before the upgrade rather than as a `1008` close. *Deferred: a docs-only
      correction to a status code no client branches on today, behind the client itself.*
- [ ] Confirm the shipped `deploy/` files end-to-end: run the systemd unit and the TLS
      reverse-proxy snippet on a real host and check the unit's sandboxing with
      `systemd-analyze security`. Both files exist and the built server starts under them
      (`BUGS.md#1`); the unit carries a baseline of process sandboxing, with stronger
      filesystem isolation documented and commented for hosts that support it. *Deferred:
      needs a host with systemd to confirm against — it cannot be checked from the test
      suite, so it waits for a machine rather than for a change.*
- [ ] Derive the routes that accept `?auth=` from the routes themselves (`BUGS.md#28`),
      rather than repeating their paths in a second list that can go stale. *Deferred: it
      fails closed and no route path is changing right now, so it is a hardening of the fix
      for `BUGS.md#27`, not a live bug.*

## Android app (v0.2)

Native Kotlin client, min SDK 26, Jetpack Compose, no Google Play Services. **This is the
next thing to build** — the server it talks to is done and running.

### Project setup

- [ ] Scaffold the Gradle project so there is something to build: a Gradle wrapper, an `app`
      module (Kotlin, Compose, min SDK 26, no Play Services), and the reverse-DNS application
      id `android/README.md` names. It builds and its unit tests run from the command line
      with `./gradlew test` and `./gradlew assembleDebug`.
- [ ] Add a CI job that builds the app and runs its unit tests, so the client is covered the
      way the server is. It gates alongside the existing `verify` job.

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

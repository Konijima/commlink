# Known issues

Tracked bugs and rough edges. Newest first. When filing one, note how to reproduce it
and how severe it is so it can be prioritized against the roadmap.

Format:

```
### <id> — <short title>   [open|fixed]   severity: low|medium|high
Repro: <the shortest reliable way to trigger it>
Notes: <cause, workaround, or fix once known>
```

---

### 6 — a graceful shutdown left the databases open   [fixed]   severity: low
Repro: not externally observable in normal use. Start the server against a file `DB_PATH`,
publish a message, then stop it with `SIGTERM`. The process exits `0`, but the SQLite
connections are never closed: with `journal_mode = WAL` the `-wal` (and `-shm`) sidecar
files are left on disk, uncheckpointed, for the next start to recover.

Notes: the entrypoint opens the message store and the token store itself and hands both to
`buildApp`, which by design closes only a store it created — an injected one is the caller's
to close (pinned by `test/ownership.test.ts`). The entrypoint was that caller and closed
neither, so the graceful-shutdown path drained the subscribers and stopped the listener but
stopped short of the database. No data is lost — a clean stop is not a power loss and the WAL
is replayed on the next open — but a graceful stop should leave a checkpointed database, and
`installShutdownHandlers` already documented that the databases are closed.

Fixed by closing both stores from an `onClose` hook in the entrypoint, so `app.close()`
reaches all the way down to SQLite. The fix lives in the entrypoint rather than `buildApp`,
so the ownership contract is unchanged. Pinned by a subprocess test that publishes through the
running server, asserts the `-wal` sidecar is on disk, sends `SIGTERM`, and asserts it is gone
once the process exits — the observable proof both connections closed. Mutation-checked:
leaving the connections open leaves the sidecar behind and fails the test.

### 5 — a failed delivery to a subscriber is swallowed without a trace   [fixed]   severity: low
Repro: not externally observable. If writing a message to a connected subscriber throws
(a WebSocket `send` or a `/json` stream `write` failing for a reason its own `error`/`close`
handler does not already catch), the broker drops the error on the floor and moves on.

Notes: the broker swallows a throwing listener on purpose — one broken socket must not
silence a topic for the others — and it was built with an `onListenerError` hook for exactly
this, but the server never wired that hook to anything. So the one failure mode the broker
defends against left no log line in a server that otherwise records everything (structured
request logs, the no-tokens warning, `?auth=` redaction): a message could reach fewer
subscribers than it should have with nothing to say why.

Fixed by routing the hook to the server's structured error log, naming the topic and message
id and carrying the thrown error, so an operator sees a delivery that failed rather than
guessing at a silent gap. The publish still succeeds and the other subscribers are unaffected
— only the visibility changed. Pinned by a test that publishes through the app to a subscriber
whose delivery throws and asserts the error is logged while the publish returns `200`.

### 4 — the backpressure suite is intermittently red   [fixed]   severity: high
Repro: run the suite enough times. It fails perhaps once in many runs, and more readily on
a slow or busy machine. Seen on CI on a change that touched only `BUGS.md`:

```
AssertionError: expected 1 to be +0 // Object.is equality
 ❯ vi.waitFor.timeout test/backpressure.test.ts:298
   Tests  1 failed | 388 passed (389)
```

Notes: the failing test is `drops a stalled reader once it stops receiving messages`. It
publishes to a stalled reader until the server drops it, counts how many messages that
took, then opens a **second** connection and publishes one message fewer — expecting to
leave the reader over the buffer limit but not yet dropped, so that only the keepalive can
drop it.

That count does not transfer between connections. The server drops a reader when
`response.writableLength` passes `maxBufferedBytes` — the bytes *this process* still holds
for it. A paused reader accumulates nothing until the kernel's socket buffers are full, and
how many bytes those absorb is decided per socket, by autotuning, not by the server. So the
second connection may absorb more than the first, leave the reader inside the limit, and
give the keepalive nothing to drop: the test then waits 2s and fails, which is the failure
above.

It fails the other way too, and more quietly. If the second connection absorbs *less*, the
reader is dropped by the delivery check while the fill is still running, and the test passes
without the keepalive ever doing anything. So a green run does not currently mean the
behaviour it names was exercised.

The server is not implicated: `dropIfBackedUp` is correct, and the same assertion passes on
`develop` and passed on the merge before this one. The test predicts something the kernel
does not promise. The fix is to observe the second connection's own buffered length rather
than predict it from the first — the server-side `ServerResponse` is reachable from the test
— and to assert the reader was still attached when the fill stopped, so the silent pass
becomes a failure.

Not reproduced locally: 6 runs of the file alone and 4 of the full suite, both pinned to two
CPUs, all green. Observed on CI, and the mechanism is legible in the source, so it is filed
on the evidence rather than held until it can be caught in the act.

**A red run cannot be told apart from a real regression, so this outranks new work.**

Fixed by having the test observe the backlog instead of predicting it. The server's own
`ServerResponse` is now held by the test, so the fill publishes one message at a time and
stops as soon as `writableLength` is over the limit and stays there — no count carries
between connections, and the second connection is gone. Because `send` weighs the backlog
*before* it writes, never publishing to a reader already over the limit means no message
delivery can be what drops it; the fill fails loudly if one ever does, so the silent pass
is now a failure. The keepalive is then the only thing left that can drop the reader, and
the test fires its tick itself: `setInterval` alone is faked, leaving the socket I/O on
real timers, so the drop no longer races a wall clock.

Verified by mutation, since a green suite was the symptom. Removing the keepalive's own
`dropIfBackedUp` check fails this test; making `send` weigh the backlog after writing
rather than before fails the fill with `delivering message 1 dropped the reader`. The file
was then run many times over, including batches launched at once to oversubscribe every
core, all green.

### 3 — a reserved topic is refused with the wrong reason   [fixed]   severity: low
Repro: subscribe to the one topic name the server keeps for itself.

```
curl -i -H "Authorization: Bearer $TOKEN" http://127.0.0.1:4500/healthz/json
HTTP/1.1 400 Bad Request
{"error":"topic must be 1-64 characters of A-Z, a-z, 0-9, hyphen or underscore"}
```

Notes: `healthz` *is* 1–64 characters of that alphabet, so the message described a rule the
request did not break. It is refused because the server serves `/healthz` itself and a topic
by that name would collide with it — which is a fair refusal, and one the client was never
told about. Any name added to the reserved set later inherited the same confusion.

Fixed by splitting the two refusals. Topic validation now returns *why* a name is refused
rather than a bare boolean: a name outside the alphabet or length still gets the alphabet
rule, but a name inside it that the server reserves for itself gets a distinct message that
names it — `topic "healthz" is reserved by the server`. The reason flows through the publish
route (`400`), the `/json` stream (`400`) and the `/ws` upgrade (close `1008`) alike, so the
same distinction reaches a client however it asked. The alphabet is checked first, so an
over-long name never reaches — and never gets echoed by — the reserved message, and any name
added to the reserved set later inherits the honest reason for free.

Verified against the running built server: `POST /healthz` and `GET /healthz/json` both
return the reserved message, `POST /bad.topic` still returns the alphabet rule, and
`POST /mytopic` still publishes.

### 2 — a non-ASCII title is stored and delivered as mojibake   [fixed]   severity: medium
Repro: publish a title with an accent, then read the message back.

```
curl -H "Authorization: Bearer $TOKEN" -H "X-Title: Café déjà vu" \
     -d "hello" http://127.0.0.1:4500/mytopic
{"id":"…","topic":"mytopic","title":"CafÃ© dÃ©jÃ  vu","message":"hello",…}
```

Notes: Node decodes request header values as latin1 — one character per byte received —
so the two bytes of a UTF-8 `é` arrive as the two characters `Ã©`, and that is what is
persisted and streamed to subscribers. The body is unaffected: it is read as UTF-8.

Settled that the headers are **UTF-8 on the wire**, not RFC 2047 encoded words: a client
sends the bytes of the text it wants shown, which is what `curl -H "X-Title: Café"` from a
UTF-8 terminal already does, and requiring an encoding scheme would burden every client
for a title the server can read as-is. Bytes that are not UTF-8 are now refused with `400`
naming the rule, rather than delivered as whatever they spell in some other encoding — a
latin1 `Café` (one 0xE9 byte) is ambiguous, and guessing quietly delivers the wrong title.

Fixed by decoding `X-Title` and `X-Tags` from the bytes they arrived as. The byte bounds
are unchanged: decoding is lossless, so re-encoding what it returns counts the same wire
bytes as before.

**The order matters, and a decode bolted on at the end would not have been enough.** Both
parsers trim surrounding space, and JavaScript's `trim()` treats `U+00A0` as whitespace —
which is also the second byte of `à` (`0xC3 0xA0`). Trimming the latin1 form therefore ate
that byte, so a title *ending* in `à` lost its last character and left a lone `0xC3` that
is not valid UTF-8 at all. `déjà` came back as `dÃ©jÃ`. The decode has to come first.

### 1 — the built server cannot start   [fixed]   severity: high
Repro: `pnpm -C server build && pnpm -C server start`

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../server/dist/app'
imported from .../server/dist/server.js
```

Notes: the package is `"type": "module"`, so Node's ESM loader needs a file extension on
every relative import. `tsconfig.json` set `"moduleResolution": "Bundler"`, which let
the source write `from './app'` and emitted it unchanged, so nothing resolved at runtime.
Only the compiled output was affected — `pnpm dev` (tsx) and `pnpm test` (vitest) resolve
extensionless imports themselves, which is why the suite was green.

This broke the documented deployment: `deploy/commlink-server.service` runs
`node dist/server.js`.

Fixed by switching the build to `"moduleResolution": "NodeNext"` and writing `./app.js` in
every relative import. NodeNext also *rejects* an extensionless relative import at compile
time, so `pnpm typecheck` now fails on the mistake rather than deferring it to runtime.
`pnpm smoke` (a new CI step) starts the compiled server and checks `/healthz`, because
neither typecheck nor the test suite loads `dist/`.

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

### 3 — a reserved topic is refused with the wrong reason   [open]   severity: low
Repro: subscribe to the one topic name the server keeps for itself.

```
curl -i -H "Authorization: Bearer $TOKEN" http://127.0.0.1:4500/healthz/json
HTTP/1.1 400 Bad Request
{"error":"topic must be 1-64 characters of A-Z, a-z, 0-9, hyphen or underscore"}
```

Notes: `healthz` *is* 1–64 characters of that alphabet, so the message describes a rule the
request did not break. It is refused because the server serves `/healthz` itself and a topic
by that name would collide with it — which is a fair refusal, and one the client is never
told about. Any name added to the reserved set later inherits the same confusion.

The fix is a distinct message for a reserved name, not a wider alphabet. Low severity: one
name, and only a client that picked it. Worth doing when the refusal messages are next
touched.

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

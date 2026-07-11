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

### 21 — `DB_PATH=:memory:` was documented as an ephemeral server, but such a server authorizes nobody   [fixed]   severity: medium
Repro: follow the docs — the README and `.env.example` both offered `:memory:` as a
deliberately ephemeral server — then try to use one.

```
cd server
DB_PATH=:memory: pnpm token:create pixel   # mints into this process's private :memory: DB
DB_PATH=:memory: pnpm start                 # a different, empty :memory: DB
curl -H "Authorization: Bearer $TOKEN" -d hi http://127.0.0.1:4500/mytopic
# HTTP/1.1 401 Unauthorized   <- the server authorizes nobody, and cannot be given a token
```

Notes: the server opens one SQLite connection for messages and another for tokens
(`server/src/server.ts`), and `token:create` runs as its own process. Each `:memory:`
connection is its own private database (`server/src/db.ts`), so none of the three share
one: the server's token store starts empty and no separate `token:create` can reach it. A
`:memory:` server therefore persists nothing and answers every publish/subscribe with `401`
— the exact "two separate throwaway databases … authorizes nobody" outcome that the blank
`DB_PATH` refusal (`server/src/dbpath.ts`) exists to prevent (#19's neighbour). The docs
recommended `:memory:` in one breath while, a line later, citing that same outcome as the
reason to refuse a blank path — a claim true only for a *single* store, which is the sense
in which the constructors legitimately default to it for tests.

Same theme as #14–#20 — an absolute claim true only under an unstated condition — but a
functional footgun like #19 rather than a wording gap: an operator who set `DB_PATH=:memory:`
got a server that authorizes nobody, diagnosable only by the no-tokens warning and the `401`.

Fixed by refusing `:memory:` as a whole-server `DB_PATH`, the same stance the blank path,
`PORT`, `HOST`, `RETENTION_HOURS` and `LOG_LEVEL` already take: `parseDbPath` throws a
distinct, named `IN_MEMORY_DB_PATH_RULE` for it, so the boot is refused before any database
is opened with a reason that explains *why* (each in-memory connection is private, so nothing
is shared or persisted). The per-store `IN_MEMORY` constructor default is untouched — a single
store with `:memory:` is coherent, which is what the tests use. The README and `.env.example`
now state that `DB_PATH` must be a real file and that both a blank value and `:memory:` are
refused. Pinned by `test/dbpath.test.ts` (a `:memory:`, trimmed or not, throws the named rule)
and `test/startup.test.ts` (the entrypoint exits non-zero naming the rule and opens no
database); both are red against the old pass-through. Verified against the compiled `dist/`:
`:memory:` is refused with the named reason, a blank path still gets its own rule, and a real
file path passes through.

### 20 — the server README said an unknown path "returns a `404`" without qualification   [fixed]   severity: low
Repro: read the API section of `server/README.md`, then probe an unknown path the way it
implies — with `curl`, without a token.

```
curl -i http://127.0.0.1:4500/no-such-path
HTTP/1.1 401 Unauthorized
{"error":"a valid bearer token is required"}
```

Notes: the section said every refusal answers in the `{ "error": … }` shape, "including an
unknown path or an unsupported method, which return `404 {"error":"not found"}`". That is
only true once the request is authenticated. Auth runs in a `preValidation` hook
(`server/src/auth.ts`) that requires a token on every route but `/healthz`, and an unknown
path matches no route — so it is refused with `401` before the not-found handler's `404`
ever runs. The codebase already draws this line: `server/src/app.ts`'s not-found handler
carries a comment that "an unauthenticated request still hears `401` before it learns
whether the route exists", and `test/notfound.test.ts` pins both sides (an *authenticated*
unknown route is `404`; a token-less one is `401`, not `404`). A client reading the API
table would probe an unknown path with a token-less `curl` — the natural thing to try — see
the `401`, and read it as a credential problem rather than the missing route it is.

Same theme as #14–#19, and the exact claim #17 corrected for `deploy/README.md`'s `/ws`
probe: an absolute statement about what a request returns that holds only under a condition
the doc did not state — here, that the request is already authenticated.

Fixed by scoping the README claim — an *authenticated* request to an unknown path or an
unsupported method is the `404`; a request without a valid token hears `401` first, because
auth precedes route resolution and only `/healthz` is open. Docs only; no code or shipped
behaviour changed, and the `401`/`404` split is already pinned by `test/notfound.test.ts`.

### 19 — the token commands ignored a `DB_PATH` set in `.env`, so tokens were minted into a different database than the server read   [fixed]   severity: medium
Repro: follow the documented setup — copy `.env.example` to `.env`, set `DB_PATH` there
(and nowhere else), then mint a token and start the server:

```
cd server
cp .env.example .env
# edit .env: DB_PATH=/var/lib/commlink/db.sqlite
pnpm token:create pixel      # writes ./commlink.sqlite, not the .env path
pnpm start                   # opens /var/lib/commlink/db.sqlite — which holds no tokens
curl -H "Authorization: Bearer $TOKEN" -d hi http://127.0.0.1:4500/mytopic
# HTTP/1.1 401 Unauthorized   <- the server authorizes nobody
```

Notes: the server loads a `.env` from its working directory before it reads `DB_PATH`
(`server/src/server.ts`, `loadEnvFile`), so a `DB_PATH` set only in `.env` — the way
`.env.example` and the README document it — is where the server opens its database. The
token commands resolved `DB_PATH` from the process environment alone
(`server/src/cli/common.ts`, `resolveDbPath`), never loading `.env`, so they missed that
value and fell back to the default `./commlink.sqlite`. An operator who did exactly what the
docs say minted the token into one database and ran the server against another: a server that
authorizes nobody, holding a token that works nowhere.

Same theme as #14–#18 — an absolute claim true only under an unstated condition — but a
functional footgun rather than a wording gap: `resolveDbPath`'s own docstring claimed it
resolved `DB_PATH` "exactly as the server resolves it," which held only when `DB_PATH` was
*also* exported as a real environment variable (where a real variable wins for both, so the
`.env` step never mattered). The blast radius is limited by the server logging a no-tokens
warning and answering `401`, so the break is diagnosable — but it silently defeats the
documented setup path.

Fixed by routing the token commands through the server's `.env` load first, then the same
`parseDbPath`: `resolveDbPath` calls `loadEnvFile({ env })` before parsing. A real environment
variable still wins, exactly as it does for the server (so the deploy guide's
`DB_PATH=… node dist/cli/token-create.js` is unaffected), and a `.env` the loader cannot parse
is refused in the command's own voice rather than resolved past to a default. Pinned by
`test/cli.test.ts`: a `.env`-only `DB_PATH` is where the token lands (and the default
`./commlink.sqlite` is never created), a real env var still wins over the `.env` value, and a
malformed `.env` refuses the command naming it. Both `.env`-picks-up cases are red against the
old code and green now.

### 18 — the publish docs said "anything you POST becomes a message", but a whitespace-only body is refused   [fixed]   severity: low
Repro: read `server/README.md`'s Publishing section — "Anything you `POST` to `/:topic`
becomes a message… taken verbatim as UTF-8" — then publish a body that is only whitespace,
with no title.

```
curl -i -H "Authorization: Bearer $TOKEN" --data-binary '   ' http://127.0.0.1:4500/mytopic
HTTP/1.1 400 Bad Request
{"error":"message body or X-Title is required"}
```

Notes: the publish route treats a body that trims to nothing as no body — it would render
as a blank notification, so with no title it is refused (`server/src/app.ts`, pinned by
`test/publish.test.ts`). That is the right behaviour, but the README's opener ("anything you
POST becomes a message") and the rule below it ("an empty request with neither is rejected")
were both absolute about *empty*, and a body of spaces or newlines is not literally empty —
a client sending a deliberately blank-looking body, or one that is just a newline, would be
surprised by the `400` after being told anything it posts is delivered. Same theme as #14–#17:
an absolute doc claim that holds only under a condition the doc did not state — here, that the
body must not trim to nothing when there is no title.

The refusal message (`message body or X-Title is required`) was also unpinned: the publish
tests asserted only the `400` status on these cases, never the reason, so a doc that quoted it
could drift from the code — the hazard #12 named.

Fixed by stating the rule precisely in the README (a *non-blank* body or a title; a
whitespace-only body counts as blank for this check, but is still delivered verbatim when a
title is present) and quoting the exact reason. The reason is now the named `EMPTY_MESSAGE_RULE`
constant (`server/src/message.ts`), matching the sibling `TITLE_RULE`/`PRIORITY_RULE`/`bodyRule`,
and `test/publish.test.ts` asserts it on every blank-message rejection so the doc quote cannot
drift. No shipped behaviour changed; the whitespace-only handling was already correct and tested.

### 17 — the deploy guide said a non-upgrade `/ws` request "is a `404`" without qualification   [fixed]   severity: low
Repro: read `deploy/README.md`'s TLS section, then probe the subscribe route over plain
HTTP the way its "test the proxy" advice implies — with `curl`, without a token.

```
curl -i http://127.0.0.1:4500/mytopic/ws
HTTP/1.1 401 Unauthorized
{"error":"a valid bearer token is required"}
```

Notes: the section explained that a proxy which drops the `Upgrade`/`Connection` headers
degrades a subscribe into a plain `GET` and breaks subscription, and stated flatly that
such a request "is a `404`". That is only true once the request is authenticated. Auth runs
in a `preValidation` hook (`server/src/auth.ts`, before any route handler), so a non-upgrade
`GET /:topic/ws` with no valid token is refused with `401` and never reaches the route's
`404` handler — the codebase already draws this line, in `test/notfound.test.ts` (an
*authenticated* non-upgrade GET is `404`; an unauthenticated unknown route is `401`, not
`404`). An operator debugging a broken subscription who probed the route with a token-less
`curl` — the natural thing to try — would see the `401`, read it as a credential problem,
and be steered away from the stripped-upgrade cause the paragraph is about. Same theme as
#14–#16: an absolute doc claim about what a request returns that holds only under a
condition the doc did not state.

Fixed by scoping the claim — an *authenticated* non-upgrade request is the `404` a real
broken subscriber sees — and adding the operator note that a token-less probe gets a `401`
first, because auth precedes the route, so a proxy test must send a valid token. Docs only;
no code or shipped-config behaviour changed, and the `401`/`404` split is already pinned by
`test/notfound.test.ts`.

### 16 — the server README claimed a `?auth=` token never reaches any log   [fixed]   severity: low
Repro: read the logging note in `server/README.md`, then deploy behind the shipped
`deploy/nginx.conf`, subscribe with the token in the URL, and read nginx's access log.

```
websocat "wss://push.example.com/mytopic/ws?auth=$TOKEN"
# nginx access log:
# 127.0.0.1 - - [.../...] "GET /mytopic/ws?auth=<TOKEN> HTTP/1.1" 101 ...
```

Notes: the README said a `?auth=<token>` subscribe token "is redacted from the request line,
so a token never reaches the log — the only place it could, since it rides in the URL". The
redaction (`server/src/logging.ts`, `redactAuthInUrl`) is real but scopes only to the
server's own pino request log. A reverse proxy in front logs the request line as it arrived,
and nginx's default `combined` format writes the full URI — query string and all — so the
token lands in the proxy's access log in clear. The README even contradicted itself: the auth
section explains publishing does *not* take `?auth=` precisely because "a query string is the
part of a URL that proxies and access logs write down". The claim was true of the server's log
and false of the proxy's, stated as an absolute. Same theme as #14 and #15: a doc claim about
what a proxy does with the request that the proxy does not honour.

Fixed by scoping the README claim to the server's own log and stating plainly that a proxy's
access log records `?auth=` in clear unless told not to, pointing at `deploy/` for how. Added
a matching note to `deploy/README.md`'s TLS section and a commented `log_format` in
`deploy/nginx.conf` that logs `$uri` (path only) in place of `$request`, so an operator whose
subscribers use `?auth=` can keep the token out of the proxy log. Docs and example config
only; no code or shipped-config behaviour changed.

### 15 — the deploy guide told Traefik users to turn response buffering on   [fixed]   severity: low
Repro: read `deploy/README.md`'s TLS section, which lists "Do not buffer the response" as a
requirement for the `/:topic/json` stream, then reaches its closing note on other proxies.

```
Traefik works too, but only once its WebSocket-upgrade and response-buffering settings
are turned on for these routes; the defaults are not enough.
```

Notes: the same section states two requirements a reverse proxy must meet — forward the
WebSocket upgrade, and *do not* buffer the response, because `/:topic/json` streams messages
as they are published and never ends, so a buffering proxy holds every line back forever. The
closing note on Traefik then told an operator to turn a "response-buffering setting" on, the
opposite of that requirement: an operator who followed it would buffer the one route that must
not be, and break streaming exactly as an unconfigured nginx does. The note also over-claimed
that Traefik's defaults are insufficient without saying for which of the two, and named a
setting to enable that contradicts the requirement stated a few lines above.

Fixed by rewording the note to the two requirements the section already sets out — forward the
upgrade, do not buffer the response — and pointing at Traefik's own documentation for the
settings that govern each, rather than naming a "buffering" setting to turn on that would break
the stream. The shipped `Caddyfile` and `nginx.conf` are unaffected; only the prose about a
third proxy changed.

### 14 — the nginx example promised client IPs in the server's request log   [fixed]   severity: low
Repro: deploy behind the example `deploy/nginx.conf`, publish or subscribe through it, and
read the server's request log.

```
{"level":30,...,"req":{"method":"POST","url":"/mytopic","host":"push.example.com","remoteAddress":"127.0.0.1"},"msg":"incoming request"}
```

Notes: the proxy block's comment said its `proxy_set_header` lines passed "the client's
details through to the server's request log". That holds for the forwarded `Host` — which
the server logs as `host` — but not for the address. The server enables no `trustProxy`, so
`request.ip` (logged as `remoteAddress`) is the connecting peer, which behind the proxy is
`127.0.0.1`: the `X-Forwarded-For`/`X-Real-IP` the block sets never reach the log. An
operator following the example would look for client addresses in the server log, find only
the proxy, and have nothing to explain the gap. The real client address is recorded in
nginx's own access log.

Fixed by rewording the comment to state what happens: the `Host` is preserved and reaches
the server's log, the client's address is forwarded in the standard headers but the request
log shows the proxy, and the client's own address lives in nginx's access log. Pinned by a
logging test that sends the forwarded headers from a distinct peer and asserts the log
carries the `Host` but not the forwarded address. Mutation-checked: enabling `trustProxy`
makes the log record the forwarded address and the test fails.

### 13 — token:create left the database open when it refused a name   [fixed]   severity: low
Repro: point `token:create` at a fresh database and give it a name it will not take, then
list what it left behind.

```
DB_PATH=/tmp/t.sqlite pnpm --silent token:create "has space"
# token:create: name must be 1-64 characters of A-Z, a-z, 0-9, hyphen or underscore
ls /tmp/t.sqlite*
# /tmp/t.sqlite  /tmp/t.sqlite-wal  /tmp/t.sqlite-shm   <- sidecars left uncheckpointed
```

Notes: the command reported an error from its `catch` by calling `fail`, which exits the
process — and an exiting process runs no `finally`, so the `tokens.close()` there was
skipped on every error path (a bad name, or a name already in use). The SQLite connection
was left open with `journal_mode = WAL`, so the `-wal` (and `-shm`) sidecars stayed on disk
uncheckpointed for the next open to recover. No data is lost — a refused create commits
nothing and the WAL is replayed on the next open — but a clean exit should leave a
checkpointed database, exactly as the server's graceful shutdown does (#6).

Same theme as #6: a store the code opened must be closed on every path out, and a `fail`
that calls `process.exit` cannot be trusted to run a `finally`. The sibling `token:revoke`
was deliberately structured around this — it does its database work in a `try/finally` and
reports failure *after* the `finally` — but `token:create` had drifted back to the
`catch { fail } / finally { close }` shape that hazard warns against.

Fixed by matching `token:revoke`: capture the error message in the `catch`, close the store
in the `finally`, then `fail` outside it. Pinned by a CLI test (`test/cli.test.ts`) that
refuses a create and asserts no `-wal` sidecar is left behind — the observable proof the
store was closed on the error path. Mutation-checked: it fails against the old code and
passes now. Verified against the compiled CLI — a duplicate name and an invalid name both
exit `1` naming the reason and leave only the main `.sqlite` file, no sidecars.

### 12 — a bad X-Priority was refused without naming the header   [fixed]   severity: low
Repro: publish with an out-of-range `X-Priority` and read the refusal.

```
curl -i -H "Authorization: Bearer $TOKEN" -H "X-Priority: 9" -d hello \
     http://127.0.0.1:4500/mytopic
HTTP/1.1 400 Bad Request
{"error":"priority must be an integer 1-5"}
```

Notes: every other publish-metadata refusal names the header the client set — `X-Title must
be at most 256 bytes`, `X-Tags must be at most 16 tags…`, `X-Title must be valid UTF-8` — so a
client reading the reason off `error` learns exactly which header to fix. `parsePriority` was
the one that did not: it blamed "priority", leaving the client to infer that meant the
`X-Priority` header it sent. Same theme as #3/#7/#9/#10 — a refusal must name a rule the client
can act on, in the client's own terms. The wording was also unpinned: the publish tests asserted
only the `400` status, never the message, so it was free to drift.

Fixed by naming the header, through a `PRIORITY_RULE` constant (`X-Priority must be an integer
1-5`) that mirrors the sibling `TITLE_RULE`/`TAGS_RULE`. Now pinned at both the parser and the
route: `parsePriority` throws it for every out-of-range value (`test/headerlimits.test.ts`), a
publish with a bad `X-Priority` answers `400 {"error":"X-Priority must be an integer 1-5"}`, and
the raw-socket repeated-header test asserts the same. Mutation-proof: the old wording no longer
contains the header the tests require. Verified against the running built server — a `9` and an
empty value both return the named rule, a valid `5` still publishes.

### 11 — token:revoke told the operator a revoked subscriber keeps streaming until it reconnects   [fixed]   severity: low
Repro: revoke a token while a subscriber is connected with it, and read what the CLI prints.

```
pnpm token:revoke pixel
Token "pixel" revoked from ./commlink.sqlite. It no longer authorizes anything.
An open subscriber keeps its stream until it disconnects.
```

Notes: the second line — and the command's docstring — claimed a subscriber already holding
an open stream keeps it until it disconnects, and that the server must be restarted to cut one
off. That is the opposite of what the server does. The subscribe routes re-check each open
connection's token against the store every keepalive interval (45s) and drop one whose token
has been revoked — a WebSocket closed with `1008 "token revoked"`, a `/json` stream ended — with
no restart (`server/src/subscribe.ts`, `server/src/stream.ts`, pinned by `test/revocation.test.ts`).
The correct behaviour was already stated in the server README, the `revoke` docstring in
`tokens.ts`, and the deploy README; only this CLI copy was never updated when the sweep landed.

User-facing: an operator revoking a compromised token was told to needlessly restart the server —
cutting off every other subscriber — or could believe the compromised subscriber was still live
when it had in fact already been dropped within the interval.

Fixed by rewording the printed line and the docstring to match the sweep — a subscriber is
dropped within a keepalive interval (45s), no restart needed, and a restart only makes it
instant. The CLI test asserted only the first output line, which is why the drift went unnoticed;
it now pins the corrected guidance (`no restart needed`) and rejects the old wording, so a
regression fails the suite.

### 10 — a publish with an over-long topic was refused with the subscribe rule   [fixed]   severity: low
Repro: publish to a single topic name longer than the router's path-segment limit — about
3.2 KB, far past the 64-character topic rule:

```
curl -i -H "Authorization: Bearer $TOKEN" -d hello \
     http://127.0.0.1:4500/$(head -c 4000 < /dev/zero | tr '\0' a)
HTTP/1.1 414 URI Too Long
{"error":"subscribe to at most 50 topics of at most 64 characters each"}
```

Notes: the router caps the topic path segment at the length of the longest legal *subscribe*
list — 50 names of 64 characters — so the same cap governs the publish `:topic` segment. A
`POST` that overran it was answered by the `frameworkErrors` hook with the subscribe-worded
reason, telling a publisher — which never subscribes and cannot act on "at most 50 topics" —
to fix a rule it was not using. A publish carries exactly one topic, so its only way to
overrun the segment is a single name that is too long. Same theme as #7 and #9: every refusal
must name a reason the client can act on off `error`.

Fixed by branching the hook's `414` on the request method. A `POST` past the segment limit is
one over-long topic and now hears the one-topic rule (`topic must be 1-64 characters of A-Z,
a-z, 0-9, hyphen or underscore`); a subscribe `GET` still names both list bounds, since it
could be either too many topics or one name too long. The malformed-URL `400` branch is
unchanged. Pinned by a `notfound.test.ts` case that publishes an over-long topic and asserts
the one-topic wording; mutation-checked, so reverting the method branch fails it on the old
subscribe wording.

### 9 — a non-upgrade GET to a subscribe socket returned an empty 404   [fixed]   severity: low
Repro: request the WebSocket route over plain HTTP, without upgrading — a browser opening
the URL, an uptime check, or a reverse proxy that dropped the `Upgrade` header:

```
curl -i -H "Authorization: Bearer $TOKEN" http://127.0.0.1:4500/mytopic/ws
HTTP/1.1 404 Not Found
    <- empty body, no content-type
```

Notes: the route was declared WebSocket-only, so the framework installed its own HTTP
fallback for a request that never upgraded — a bare `404` with no body. Because the route
*matched*, the server's not-found handler (which answers in the `{ "error": … }` shape)
never ran, so this one response broke the promise that every unexpected reply names its
reason on `error`. It is also the exact failure a mis-set proxy produces, where an empty
body left nothing to explain the broken subscription.

Fixed by giving the route an explicit HTTP handler alongside its WebSocket one, so a
non-upgrade `GET /:topic/ws` now answers `404 {"error":"not found"}` like every other
refusal, while the upgrade path is unchanged. Pinned by a test that requests the route
without upgrading; mutation-checked against the old empty 404.

### 8 — a body refused before authentication is not charged to the rate limit   [fixed]   severity: low
Repro: with a low publish rate limit, POST a body that is not UTF-8, or one over 4096
bytes, repeatedly with a valid token. Each is refused (`400`/`413`), but none counts
against the token's budget — whereas a `400` from a bad `X-Priority` header does count.
The rate-limit docs said "every attempt is charged, including one the server goes on to
reject with 400".

Notes: the body is validated as it is read, before the hook that charges the rate limit
runs — the same ordering that lets an over-long body be refused before the token is looked
at. So a body the server rejects that early names no token to charge, which is defensible
(such a client is refused every request regardless, and the limit exists to protect
subscribers from *delivered* floods, which these never become). The rough edge was the
blanket "every 400 is charged" wording, which is not literally true for a body rejected
pre-auth.

Fixed by reconciling the docs rather than moving the limiter ahead of body parsing, since
the behaviour is the deliberate one. The server README's rate-limit section now says only a
request that reaches the limiter — which runs just after authentication — is charged, and
that a body refused while it is read (`413` over-long, `400` non-UTF-8) spends nothing, like
an unauthenticated request. The over-long half was already pinned by `bodylimit.test.ts`;
the non-UTF-8 half is now pinned by `bodyencoding.test.ts`, mutation-checked so that
charging the refused body fails the test.

### 7 — an over-long subscribe topic list leaks the framework's default error shape   [fixed]   severity: low
Repro: subscribe to a comma-separated list long enough to overrun the router's path-segment
limit — 51 topics at the full 64-character length, about 3.3 KB of URL. The response is a
`414` carrying the framework's default `{error,code,message}` body instead of the plain
`{ "error": … }` shape and the "subscribe to at most 50 comma-separated topics" reason. A
list of 51 *short* topics still gets that friendly `400`.

Notes: the topic segment's length is capped by the router before any route runs, so an
over-long one is answered by the framework's built-in `414`, which the server's error and
not-found handlers do not cover. Very narrow — it needs a multi-kilobyte URL — but it is
one more place a client cannot read the reason off `error`.

Fixed with a `frameworkErrors` hook, which catches the two refusals the router makes before
any route — and so before the error and not-found handlers — runs: a path segment past the
limit (`414`) and a path that is not a valid URL (`400`, e.g. a broken percent-escape). Both
now answer in the `{ error }` shape every other refusal uses. The `414`'s reason names both
bounds an over-long segment could have broken — `subscribe to at most 50 topics of at most
64 characters each` — since it stands in for either "too many topics" or "one name too
long". A legal 51-*short*-topic list still reaches the route and gets the friendlier `400`.
Verified against the running built server: an over-long list on `/json` and on a non-upgrade
`/ws` both return the `414 { error }` shape, a malformed URL returns the `400 { error }`
shape, and the short-list `400` is unchanged.

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

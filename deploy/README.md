# Deployment

Generic notes for running the commlink server on your own machine. The server itself
binds loopback (`127.0.0.1:4500` by default) and should be exposed through a TLS reverse
proxy rather than binding a public interface directly.

This directory holds example configuration you can adapt:

- [`commlink-server.service`](./commlink-server.service) — a systemd unit that runs the
  server as a service.
- [`Caddyfile`](./Caddyfile) — a minimal TLS reverse-proxy snippet.
- [`nginx.conf`](./nginx.conf) — the same for nginx, with the WebSocket and buffering
  settings this server needs already set.

These are starting points, not turnkey configs — adjust paths, the domain, and the user
to match your host.

## systemd

The unit runs the compiled server — its `ExecStart` is `node dist/server.js` — so build
`dist/` before enabling the service, and again after each update. A fresh checkout does
not ship it: without this step the unit crash-loops on `Cannot find module dist/server.js`
with nothing to explain why.

```bash
cd server
pnpm install     # dev dependencies included; the TypeScript compiler is one of them
pnpm build       # emits dist/, which the unit runs
```

Then install and start the unit:

```bash
# Adjust WorkingDirectory and ExecStart in the unit first — the shipped WorkingDirectory
# is a placeholder (/opt/commlink/server), so point it at your checkout. A user service
# runs as you, so there is no User= line to set — systemd does not honor one in a user
# unit.
cp commlink-server.service ~/.config/systemd/user/    # user service
systemctl --user daemon-reload
systemctl --user enable --now commlink-server.service
```

A user service runs only while you have an active login session: systemd starts it
when you log in and stops it when your last session ends. Deployed as-is it would go
down the moment you log out and stay down until the next login — not what a push server
you rely on should do. Enable lingering once so the user manager, and the service with
it, start at boot and keep running with nobody logged in:

```bash
sudo loginctl enable-linger "$USER"
```

The unit's `WantedBy=default.target` then brings the server up at boot. A system unit in
`/etc/systemd/system/` runs at boot without lingering, but starts as root: add a
`User=`/`Group=` for a dedicated unprivileged account so the server does not run with more
than it needs.

**Write every path in the unit absolute — do not reach for `%h`.** systemd's specifiers
that name a home or a state root follow the *service manager*, not `User=`; the manual says
of `%h` in so many words that it "is not influenced by the `User=` setting". Under
`systemctl --user` the manager is you, so `%h` is your home and looks like it follows the
account — but under the system manager it is `/root`, whatever `User=` says. A system unit
with `User=commlink` and `WorkingDirectory=%h/commlink/server` therefore looks for the
checkout in `/root/commlink/server`, which is not where it is and which an unprivileged
account cannot enter regardless, and the service dies on a `CHDIR` error before it runs any
of the server. The shipped unit uses an absolute placeholder (`/opt/commlink/server`) for
that reason; put the checkout wherever the account can read it and say so in full.

`%S` is manager-scoped in the same way — `/var/lib` for a system unit, `$XDG_STATE_HOME`
(usually `~/.local/state`) for a user one — but unlike `%h` that is the correct state root
in each case, so `StateDirectory=` and the `%S`-based `DB_PATH` need no adjusting. Under a
system unit with `User=` set, `StateDirectory=commlink` creates `/var/lib/commlink` owned by
that account.

The unit points `DB_PATH` at that state directory, outside the checkout. `DB_PATH` is
resolved relative to `WorkingDirectory`, so a unit that leaves it unset writes the
message database into the source tree — where a redeploy can wipe it.

### Sandboxing

The unit ships with a baseline of systemd's process sandboxing turned on:
`NoNewPrivileges`, `RestrictSUIDSGID`, `RestrictRealtime`, `RestrictNamespaces`,
`LockPersonality` and `SystemCallArchitectures=native`. These are seccomp- and
rlimit-based rather than mount-namespace-based, so they apply to a `systemctl --user`
unit as readily as a system one, and the server — which never elevates privileges,
creates namespaces, or uses realtime scheduling — runs unaffected.

Stronger, filesystem-level isolation (`ProtectSystem=strict`, `PrivateTmp`, the
`Protect*` kernel options, and friends) is included **commented out**, because it
relies on mount namespacing: a system unit always has it, but a `systemctl --user`
unit can set it up only where unprivileged user namespaces are enabled, and enabling
it unconditionally would break the user-service path on hosts without them. For a
system unit — or a user host that supports it — uncomment that block and confirm the
result with `systemd-analyze security commlink-server.service`. `MemoryDenyWriteExecute`
is left off entirely: it breaks the JIT the Node runtime depends on.

## Tokens

A freshly deployed server authorizes nobody: every route but `/healthz` needs a bearer
token, and the database starts with none. It says so in its log at startup, and refuses
every publish and subscribe with `401` until you mint one.

**Start the service first, then mint.** `StateDirectory=commlink` creates the state
directory the unit's `DB_PATH` points into, and it does that when the service first runs —
so a token minted before the first start has nowhere to go. SQLite will not create a missing
parent directory, and the command says so rather than leaving you to guess:

```
token:create: cannot open the database at /var/lib/commlink/commlink.sqlite: Cannot open
database because the directory does not exist. Check DB_PATH; …
```

Once the service has started, mint against the same `DB_PATH` the unit uses:

```bash
DB_PATH=/path/to/state/commlink.sqlite node dist/cli/token-create.js pixel
```

**Name `DB_PATH` on the command, every time.** The unit sets it with `Environment=`, which
puts it in the *service's* environment and nowhere else, so it is not in the shell you run
the token command from. The command resolves its own `DB_PATH` — from a `.env` in its
working directory, then the variable — and falls back to `./commlink.sqlite`, so a bare
`pnpm token:create` mints into the checkout instead: a token that works nowhere, against a
server that still authorizes nobody. The startup warning prints the whole command with the
server's own path already in it; copy that.

The token is printed once. Keep it out of shell history and version control — the
server stores only its hash and cannot recover it.

Two more commands manage what has been issued. Both take the same `DB_PATH`, and neither
needs the server stopped:

```bash
DB_PATH=/path/to/state/commlink.sqlite node dist/cli/token-list.js
DB_PATH=/path/to/state/commlink.sqlite node dist/cli/token-revoke.js pixel
```

A revoked token is refused from the next request onward, and a subscriber already holding
an open stream is dropped automatically within one keepalive interval (45s) — no reconnect
or restart needed. `systemctl --user restart commlink-server.service` cuts every connection
off at once if you would rather not wait the interval out.

## TLS

Point any reverse proxy that terminates TLS at `http://127.0.0.1:4500`. Two things
matter for this server, because a subscriber holds one long-lived connection rather than
making a short request each time:

- **Forward the WebSocket upgrade.** The `/:topic/ws` subscribe route — the primary way
  clients connect — answers only the WebSocket handshake; an authenticated request to it
  without the `Upgrade` and `Connection` headers opens no socket and is answered `404`. A
  proxy that does not pass those headers through therefore breaks subscription entirely,
  with nothing to explain why. If you probe the route with `curl` to test the proxy, send
  a valid token: the auth check runs before the route, so a non-upgrade request with no
  token is a `401`, which reads as a credential problem rather than the stripped upgrade
  it actually is.
- **Do not buffer the response.** The `/:topic/json` fallback streams messages as they
  are published and never ends on its own, so a proxy that buffers the body holds every
  line back until the stream closes — that is, until never. The route sends
  `X-Accel-Buffering: no` to opt out where that header is honoured; a proxy with its own
  response buffering needs it turned off for this path.

One more thing to weigh, because a subscriber's credential rides in the URL: a browser
cannot set a header on a WebSocket handshake, so a browser subscriber sends its bearer
token as `?auth=<token>` in the query string. The server redacts it from its own request
log, but a reverse proxy logs the request line as it arrived — nginx's default `combined`
format writes the full URI, query string and all — so the token is persisted in the
proxy's access log in clear. If your subscribers use `?auth=`, keep the proxy from logging
it: turn the access log off for these routes, or use a log format that omits the query
string (nginx's `$uri` in place of `$request`), so the token is not written where the
server took care not to write it. The included `nginx.conf` ships that format ready to
uncomment, in two halves — mind which goes where. `log_format` is an `http`-context
directive, like the `map` block beside it: nginx refuses to load one written inside a
`server` or `location` (`[emerg] "log_format" directive is not allowed here`) and will not
start, so a config that defines the format down where it is used takes the whole proxy down
rather than protecting the token. The definition belongs at the top level; only the
`access_log` line that names the format goes in `location /`, and the two are correct only
together — an `access_log` naming a format nothing defines is refused just as flatly
(`[emerg] unknown log format "no_query"`).

The included `Caddyfile` satisfies both with no extra configuration: Caddy forwards
WebSocket upgrades and streams responses unbuffered by default. nginx does neither on
its own — the included [`nginx.conf`](./nginx.conf) sets both explicitly, and its
comments mark which line does which. Traefik works too, on the same two requirements: it
must forward the WebSocket upgrade and must **not** buffer the response — buffering would
hold the `/:topic/json` stream back the way an unconfigured nginx does. Consult its
documentation for the settings that govern each.

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
# Adjust WorkingDirectory / ExecStart / User in the unit first.
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

The unit's `WantedBy=default.target` then brings the server up at boot. (A system unit
in `/etc/systemd/system/` runs at boot without this, but then runs as root rather than
your user — adjust `%h`/`%S` in the paths accordingly.)

The unit points `DB_PATH` at a state directory outside the checkout. `DB_PATH` is
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
token, and the database starts with none. Mint one against the same `DB_PATH` the unit
uses, before or after the first start:

```bash
DB_PATH=/path/to/state/commlink.sqlite node dist/cli/token-create.js pixel
```

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
  clients connect — answers only the WebSocket handshake; a plain request to it without
  the `Upgrade` and `Connection` headers is a `404`. A proxy that does not pass those
  headers through therefore breaks subscription entirely, with nothing to explain why.
- **Do not buffer the response.** The `/:topic/json` fallback streams messages as they
  are published and never ends on its own, so a proxy that buffers the body holds every
  line back until the stream closes — that is, until never. The route sends
  `X-Accel-Buffering: no` to opt out where that header is honoured; a proxy with its own
  response buffering needs it turned off for this path.

The included `Caddyfile` satisfies both with no extra configuration: Caddy forwards
WebSocket upgrades and streams responses unbuffered by default. nginx does neither on
its own — the included [`nginx.conf`](./nginx.conf) sets both explicitly, and its
comments mark which line does which. Traefik works too, but only once its
WebSocket-upgrade and response-buffering settings are turned on for these routes; the
defaults are not enough.

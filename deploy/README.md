# Deployment

Generic notes for running the commlink server on your own machine. The server itself
binds loopback (`127.0.0.1:4500` by default) and should be exposed through a TLS reverse
proxy rather than binding a public interface directly.

This directory holds example configuration you can adapt:

- [`commlink-server.service`](./commlink-server.service) — a systemd unit that runs the
  server as a service.
- [`Caddyfile`](./Caddyfile) — a minimal TLS reverse-proxy snippet.

These are starting points, not turnkey configs — adjust paths, the domain, and the user
to match your host.

## systemd

```bash
# Adjust WorkingDirectory / ExecStart / User in the unit first.
cp commlink-server.service ~/.config/systemd/user/    # user service
systemctl --user daemon-reload
systemctl --user enable --now commlink-server.service
```

The unit points `DB_PATH` at a state directory outside the checkout. `DB_PATH` is
resolved relative to `WorkingDirectory`, so a unit that leaves it unset writes the
message database into the source tree — where a redeploy can wipe it.

## Tokens

A freshly deployed server authorizes nobody: every route but `/healthz` needs a bearer
token, and the database starts with none. Mint one against the same `DB_PATH` the unit
uses, before or after the first start:

```bash
DB_PATH=/path/to/state/commlink.sqlite node dist/cli/token-create.js pixel
```

The token is printed once. Keep it out of shell history and version control — the
server stores only its hash and cannot recover it.

## TLS

Point any reverse proxy that terminates TLS at `http://127.0.0.1:4500`. The included
`Caddyfile` does this in a couple of lines; nginx, Traefik, or Caddy all work equally
well.

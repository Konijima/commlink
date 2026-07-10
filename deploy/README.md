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

## TLS

Point any reverse proxy that terminates TLS at `http://127.0.0.1:4500`. The included
`Caddyfile` does this in a couple of lines; nginx, Traefik, or Caddy all work equally
well.

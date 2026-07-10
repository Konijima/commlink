/**
 * The port the server binds when `PORT` is unset. Loopback-facing: a TLS reverse proxy
 * terminates in front of it rather than the server binding a public interface (see deploy/).
 */
export const DEFAULT_PORT = 4500;

/** What the server tells an operator whose `PORT` is not one it can bind. */
export const PORT_RULE =
  'PORT must be a whole number from 0 to 65535 (0 picks a free port)';

/**
 * Resolve `PORT` from the environment. Absent means {@link DEFAULT_PORT}.
 *
 * Throws a `RangeError` naming the rule for anything else. `Number(process.env.PORT)`
 * alone takes `abc` as `NaN`, keeps a fraction like `8080.5`, and accepts a value outside
 * the 16-bit range, then hands each to `listen`: `NaN`, `8080.5` and `99999` all fail there
 * with an `ERR_SOCKET_BAD_PORT` stack trace that never names the setting and only after the
 * database file has been opened. A port is validated here so a typo surfaces at boot, tagged
 * and before any side effect — the same stance `RETENTION_HOURS` and `LOG_LEVEL` take.
 *
 * `0` is allowed: it asks the OS for a free ephemeral port, which is how a smoke run and the
 * shutdown test avoid colliding with a dev server.
 */
export function parsePort(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_PORT;

  const trimmed = raw.trim();
  // Digits only, as parseRetentionHours does: `Number` alone would take `1e3`, `0x10`, ` `.
  if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(Number(trimmed))) {
    throw new RangeError(PORT_RULE);
  }

  const port = Number(trimmed);
  // The regex already rules out a negative; this bounds the top of the 16-bit range.
  if (port > 65535) throw new RangeError(PORT_RULE);

  return port;
}

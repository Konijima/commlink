/**
 * The interface the server binds when `HOST` is unset. Loopback: a TLS reverse proxy
 * terminates in front of it rather than the server binding a public interface (see deploy/).
 * Set `HOST=0.0.0.0` (or a specific address) to bind elsewhere on a trusted network.
 */
export const DEFAULT_HOST = '127.0.0.1';

/** What the server tells an operator whose `HOST` is one it will not bind. */
export const HOST_RULE = 'HOST must be a non-empty hostname or address';

/**
 * Resolve `HOST` from the environment. Absent means {@link DEFAULT_HOST}.
 *
 * Throws a `RangeError` naming the rule for a blank value. `process.env.HOST ?? DEFAULT_HOST`
 * alone only falls back when the variable is unset; an empty string — which is what a
 * `HOST=` line in `.env`, or `HOST= ` in the shell, leaves behind — is not nullish, so it
 * passes straight through to `listen`. Node treats an empty host as *unspecified* and binds
 * every interface, quietly turning a loopback default into a public one. An operator who
 * blanked the line almost never meant that, so it is refused at boot, tagged and before the
 * database is opened — the same stance `PORT`, `RETENTION_HOURS` and `LOG_LEVEL` take.
 *
 * A non-blank value is passed through as given (trimmed): a hostname, `0.0.0.0`, `::` or a
 * specific address are all legitimate binds for a self-hosted server, and one the machine
 * cannot resolve still fails at `listen` — but visibly, not by silently binding elsewhere
 * than intended.
 */
export function parseHost(raw: string | undefined): string {
  if (raw === undefined) return DEFAULT_HOST;

  const trimmed = raw.trim();
  if (trimmed === '') throw new RangeError(HOST_RULE);

  return trimmed;
}

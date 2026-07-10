/**
 * Where the SQLite database lives when `DB_PATH` is unset. A relative path resolves
 * against the working directory, so a service manager should set an absolute one.
 */
export const DEFAULT_DB_PATH = './commlink.sqlite';

/** What the server tells an operator whose `DB_PATH` is one it will not open. */
export const DB_PATH_RULE = 'DB_PATH must be a non-empty file path';

/**
 * Resolve `DB_PATH` from the environment. Absent means {@link DEFAULT_DB_PATH}.
 *
 * Throws a `RangeError` naming the rule for a blank value. `process.env.DB_PATH ??
 * DEFAULT_DB_PATH` alone only falls back when the variable is unset; an empty string —
 * what a `DB_PATH=` line in `.env`, or `DB_PATH= ` in the shell, leaves behind — is not
 * nullish, so it passes straight through to SQLite. SQLite opens an empty filename as a
 * *private, temporary on-disk database that is deleted when the connection closes*, and
 * the server opens one connection for messages and another for tokens, so a blank path
 * yields two separate throwaway databases: nothing an operator publishes survives a
 * restart, and the token store starts empty so it authorizes nobody. An operator who
 * blanked the line almost never meant that, so it is refused at boot, tagged and before
 * any database is opened — the same stance `PORT`, `HOST`, `RETENTION_HOURS` and
 * `LOG_LEVEL` take.
 *
 * A non-blank value is passed through as given (trimmed): a file path, or the literal
 * `:memory:` for a deliberately ephemeral server, are both legitimate. A path that
 * cannot be opened still fails when the store is constructed — but visibly, not by
 * silently persisting nowhere.
 */
export function parseDbPath(raw: string | undefined): string {
  if (raw === undefined) return DEFAULT_DB_PATH;

  const trimmed = raw.trim();
  if (trimmed === '') throw new RangeError(DB_PATH_RULE);

  return trimmed;
}

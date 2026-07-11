import { IN_MEMORY } from './db.js';

/**
 * Where the SQLite database lives when `DB_PATH` is unset. A relative path resolves
 * against the working directory, so a service manager should set an absolute one.
 */
export const DEFAULT_DB_PATH = './commlink.sqlite';

/** What the server tells an operator whose `DB_PATH` is blank. */
export const DB_PATH_RULE = 'DB_PATH must be a non-empty file path';

/**
 * What the server tells an operator who set `DB_PATH` to the in-memory database. Named
 * apart from {@link DB_PATH_RULE} so the operator learns which mistake this is, and why a
 * value that is neither blank nor a bad path is still refused.
 */
export const IN_MEMORY_DB_PATH_RULE =
  'DB_PATH must be a file path, not the in-memory database (":memory:"): the server holds ' +
  'a separate connection for messages and for tokens, and an in-memory database is private ' +
  'to each connection, so nothing persists and the token store authorizes nobody';

/**
 * Resolve `DB_PATH` from the environment. Absent means {@link DEFAULT_DB_PATH}.
 *
 * Throws a `RangeError` naming the rule for a value the server cannot open as its
 * database. `process.env.DB_PATH ?? DEFAULT_DB_PATH` alone only falls back when the
 * variable is unset; an empty string — what a `DB_PATH=` line in `.env`, or `DB_PATH= `
 * in the shell, leaves behind — is not nullish, so it passes straight through to SQLite.
 * SQLite opens an empty filename as a *private, temporary on-disk database that is deleted
 * when the connection closes*, and the server opens one connection for messages and another
 * for tokens, so a blank path yields two separate throwaway databases: nothing an operator
 * publishes survives a restart, and the token store starts empty so it authorizes nobody.
 *
 * The literal `:memory:` is refused for the same outcome from the other direction: it is a
 * legitimate value for a *single* store — the constructors default to it for tests — but as
 * a whole-server `DB_PATH` it is a trap, because each in-memory connection is its own private
 * database. The message and token stores would not share one, and `token:create` runs as its
 * own process against yet another, so a `:memory:` server persists nothing and can never be
 * given a token to authorize with. An operator almost never means either, so both are refused
 * at boot, tagged and before any database is opened — the same stance `PORT`, `HOST`,
 * `RETENTION_HOURS` and `LOG_LEVEL` take.
 *
 * Any other non-blank value is passed through as given (trimmed): a real file path. A path
 * that cannot be opened still fails when the store is constructed — but visibly, not by
 * silently persisting nowhere.
 */
export function parseDbPath(raw: string | undefined): string {
  if (raw === undefined) return DEFAULT_DB_PATH;

  const trimmed = raw.trim();
  if (trimmed === '') throw new RangeError(DB_PATH_RULE);
  if (trimmed === IN_MEMORY) throw new RangeError(IN_MEMORY_DB_PATH_RULE);

  return trimmed;
}

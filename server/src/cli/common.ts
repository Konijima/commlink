/**
 * What the token commands share: the database they act on, and how they refuse.
 *
 * The path matters more than it looks. `token:create` writing to one database while the
 * server reads another is a server that authorizes nobody and an operator holding a
 * token that works nowhere — so all three commands read the variable in one place, and
 * resolve it exactly as the server does: a `.env` from the working directory first, then
 * the same {@link parseDbPath}.
 */

import { parseDbPath } from '../dbpath.js';
import { loadEnvFile } from '../env.js';
import { TokenStore } from '../tokens.js';

/** Refuses, and never returns. */
export type Fail = (message: string) => never;

/**
 * How `command` reports that it will not do what it was asked.
 *
 * The message names the command, because an operator reads it out of a script's output
 * with no other clue as to which one refused, and it goes to stderr, because stdout is
 * where these commands put the one thing a caller wants to capture.
 */
export function failWith(command: string): Fail {
  return (message: string): never => {
    console.error(`${command}: ${message}`);
    process.exit(1);
  };
}

/**
 * The single token name in `argv`, or a refusal naming `usage`.
 *
 * An empty name is a mistake, not an absent argument: it is what a shell hands over
 * when it expands an unset variable, and minting or revoking whatever `""` happens to
 * match is not what the caller meant. A second name is a mistake too — better to refuse
 * than to silently act on the first and drop the rest.
 */
export function oneName(
  fail: Fail,
  usage: string,
  argv: string[] = process.argv,
): string {
  const name: string | undefined = argv[2];
  if (name === undefined || name.length === 0) return fail(usage);
  if (argv.length > 3) return fail('one name at a time');

  return name;
}

/**
 * The database path the command acts on, resolved exactly as the server resolves it: a
 * `.env` from the working directory is loaded first, then {@link parseDbPath} trims the
 * value and refuses a blank or whitespace-only one.
 *
 * Both halves matter, because either one skipped lets a command mint into a database the
 * server never opens:
 *
 * - The server loads a `.env` before it reads `DB_PATH` (`server.ts`), so `DB_PATH` set
 *   only in `.env` — the documented way to configure it (`.env.example`) — is where the
 *   server looks. A command that read the process environment alone would miss it and fall
 *   back to the default `./commlink.sqlite`, minting where the server never reads. So the
 *   command loads the same `.env`, from the same working directory; a real environment
 *   variable still wins, exactly as it does for the server, and a `.env` it cannot parse
 *   is refused rather than resolved past to a default.
 * - Reading `process.env.DB_PATH` raw — the way this once did — also let a blank `DB_PATH=`,
 *   or one that is only spaces, slip the `?? default` that fills in an *unset* variable and
 *   reach SQLite, which opens an empty filename as a private throwaway database. Routing
 *   the value through `parseDbPath`, as the server does, refuses it instead.
 *
 * Anything wrong — an unparseable `.env`, a blank path — is reported through `fail`, in
 * the command's own voice and to stderr, rather than thrown as an uncaught error with a
 * stack trace an operator has to decode.
 */
export function resolveDbPath(fail: Fail, env: NodeJS.ProcessEnv = process.env): string {
  try {
    loadEnvFile({ env });
    return parseDbPath(env.DB_PATH);
  } catch (error) {
    return fail((error as Error).message);
  }
}

/**
 * The token store at `dbPath`, or a refusal in the command's own voice.
 *
 * Opening is the step most likely to fail on a real deployment, and it fails for a reason
 * the operator can act on: the directory `DB_PATH` names does not exist. SQLite will not
 * create a missing parent, and a unit that keeps its database in a `StateDirectory=` gets
 * that directory created at the server's *first start* — so a token minted before the
 * server has ever run has nowhere to be written. Left to throw, that arrives as an uncaught
 * error and a stack trace that names neither `DB_PATH` nor the command; caught here, it
 * names both, and the setting the operator has to fix.
 */
export function openTokenStore(fail: Fail, dbPath: string): TokenStore {
  try {
    return new TokenStore(dbPath);
  } catch (error) {
    return fail(
      `cannot open the database at ${dbPath}: ${(error as Error).message}. Check DB_PATH; ` +
        `its directory must already exist, and a server that keeps its database in a ` +
        `systemd StateDirectory only creates that directory at its first start.`,
    );
  }
}

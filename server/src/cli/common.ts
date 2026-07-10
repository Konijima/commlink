/**
 * What the token commands share: the database they act on, and how they refuse.
 *
 * The path matters more than it looks. `token:create` writing to one database while the
 * server reads another is a server that authorizes nobody and an operator holding a
 * token that works nowhere — so all three commands read the variable in one place, and
 * read it from the same `DB_PATH` the server does.
 */

/** Where the tokens live. The server resolves `DB_PATH` the same way. */
export const DB_PATH = process.env.DB_PATH ?? './commlink.sqlite';

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

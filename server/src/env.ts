import { readFileSync } from 'node:fs';

/** Where the server looks for a `.env` file when none is named. Resolved from the cwd. */
export const DEFAULT_ENV_PATH = '.env';

/** What the loader tells an operator whose `.env` has a line it cannot read. */
export function envLineRule(lineNumber: number): string {
  return `.env line ${lineNumber}: expected KEY=value, a blank line, or a # comment`;
}

/**
 * What the loader tells an operator whose `.env` sets the same key twice. It names both
 * lines, since the operator has to decide which of the two they meant to keep.
 */
export function envDuplicateRule(
  key: string,
  lineNumber: number,
  firstLine: number,
): string {
  return `.env line ${lineNumber}: ${key} is already set on line ${firstLine}`;
}

/**
 * A single `KEY=value` assignment. `raw` is the value exactly as it will be exported —
 * quotes stripped, but otherwise untouched.
 */
export interface EnvAssignment {
  key: string;
  value: string;
}

// A key is a shell-style identifier: a letter or underscore, then letters, digits or
// underscores. Anything else — a leading digit, a dot, a space around the `=` — is a
// line the operator did not mean as configuration, and is reported rather than guessed at.
const KEY_RULE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Parse the contents of a `.env` file into ordered assignments.
 *
 * The grammar is deliberately small, because a `.env` file is edited by hand and a
 * surprising rule is worse than a missing one:
 *
 * - A blank line, or one whose first non-space character is `#`, is a comment and skipped.
 * - Otherwise the line is `KEY=value`. The key is a shell identifier; the value is the
 *   rest of the line. A value wrapped in matching single or double quotes keeps whatever
 *   is inside them verbatim — leading spaces, a `#`, an `=`; an unquoted value is trimmed
 *   of surrounding whitespace.
 * - A `#` only starts a comment at the start of a line, never inline: put a comment on its
 *   own line. Trimming an inline comment off an unquoted value would silently eat a `#`
 *   that belongs to a token or a path.
 * - A key may be set at most once. Two lines assigning the same key are ambiguous — the
 *   operator meant one of them — so the second throws rather than one silently winning.
 *
 * A line that is none of these throws a `SyntaxError` naming the line number, rather than
 * being skipped: a typo'd assignment that vanished would leave the server running on a
 * default the operator thought they had changed.
 */
export function parseEnv(contents: string): EnvAssignment[] {
  const assignments: EnvAssignment[] = [];
  // Where each key was first assigned, so a repeat is named against its first appearance
  // rather than silently keeping one line and dropping the other. Keys are case-sensitive,
  // as the environment is on the platforms the server runs on, so `PORT` and `port` differ.
  const firstSeenAt = new Map<string, number>();

  const lines = contents.split('\n');
  for (let i = 0; i < lines.length; i++) {
    // Tolerate CRLF files: a trailing `\r` is not part of the value.
    const line = lines[i].replace(/\r$/, '');
    const trimmedStart = line.trimStart();

    if (trimmedStart === '' || trimmedStart.startsWith('#')) continue;

    const eq = line.indexOf('=');
    const key = eq === -1 ? '' : line.slice(0, eq).trim();
    if (eq === -1 || !KEY_RULE.test(key)) {
      throw new SyntaxError(envLineRule(i + 1));
    }

    const firstLine = firstSeenAt.get(key);
    if (firstLine !== undefined) {
      throw new SyntaxError(envDuplicateRule(key, i + 1, firstLine));
    }
    firstSeenAt.set(key, i + 1);

    assignments.push({ key, value: unwrap(line.slice(eq + 1)) });
  }

  return assignments;
}

/**
 * A value wrapped in a matching pair of quotes is taken verbatim from between them; any
 * other value is trimmed. Only a pair counts — a stray leading quote is part of the value.
 */
function unwrap(rawValue: string): string {
  const value = rawValue.trim();
  if (value.length >= 2) {
    const first = value[0];
    if ((first === '"' || first === "'") && value[value.length - 1] === first) {
      return value.slice(1, -1);
    }
  }
  return value;
}

export interface LoadEnvResult {
  /** The keys that were applied to the environment. */
  applied: string[];
  /** The keys the file set that a real environment variable already overrode. */
  skipped: string[];
}

export interface LoadEnvOptions {
  /** The file to read. Defaults to {@link DEFAULT_ENV_PATH}, resolved from the cwd. */
  path?: string;
  /** The environment to populate. Defaults to `process.env`; injectable for tests. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Load a `.env` file into the environment so `pnpm start` picks up a copied
 * `.env.example` without every value being exported by hand first.
 *
 * A real environment variable always wins: a key already set is left as it is and
 * reported in `skipped`, so a `systemd` `Environment=` or a one-off `PORT=… pnpm start`
 * overrides a committed default rather than being silently overwritten by the file.
 *
 * A missing file is not an error — the server reads straight from the environment when
 * there is no file, exactly as it did before this landed. A file that exists but cannot
 * be read or parsed *is* an error: it is a file the operator wrote and expects to take
 * effect, so a malformed one is surfaced rather than run past.
 */
export function loadEnvFile(options: LoadEnvOptions = {}): LoadEnvResult {
  const path = options.path ?? DEFAULT_ENV_PATH;
  const env = options.env ?? process.env;

  let contents: string;
  try {
    contents = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { applied: [], skipped: [] };
    }
    throw err;
  }

  const applied: string[] = [];
  const skipped: string[] = [];
  for (const { key, value } of parseEnv(contents)) {
    if (env[key] !== undefined) {
      skipped.push(key);
      continue;
    }
    env[key] = value;
    applied.push(key);
  }

  return { applied, skipped };
}

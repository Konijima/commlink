import { createHash, randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import { IN_MEMORY, openDatabase } from './db.js';

/**
 * How many random bytes back a token. 256 bits of entropy is far past anything that
 * can be guessed, online or off, which is what lets the server treat any single
 * presented token as either right or wrong and nothing in between.
 */
const TOKEN_BYTES = 32;

export const MAX_TOKEN_NAME_LENGTH = 64;

/** Names label tokens in the database and on the command line; keep them boring. */
const TOKEN_NAME_PATTERN = new RegExp(`^[A-Za-z0-9_-]{1,${MAX_TOKEN_NAME_LENGTH}}$`);

/** What the token CLI tells an operator who chose a name the server will not store. */
export const TOKEN_NAME_RULE = `name must be 1-${MAX_TOKEN_NAME_LENGTH} characters of A-Z, a-z, 0-9, hyphen or underscore`;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS tokens (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL UNIQUE,
    hash       TEXT    NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  );
`;

/**
 * Mint a token: 32 random bytes, base64url-encoded.
 *
 * base64url rather than base64 because a WebSocket client presents its token in a
 * query string, where `+`, `/` and `=` would each have to be escaped.
 */
export function mintToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/**
 * The stored form of a token.
 *
 * Only the hash is written down, so a stolen database yields no token that can be
 * presented back to the server. A plain SHA-256 is enough here where a password would
 * need a slow KDF: a token is 256 uniform random bits, not a memorable secret, so
 * there is no smaller space than the whole one for an attacker to search.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Whether `error` is SQLite refusing a duplicate `name` or `hash`. */
function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE'
  );
}

/**
 * The tokens that may publish to and subscribe from this server.
 *
 * A store with no tokens in it authorizes nobody: a fresh install serves `/healthz`
 * and refuses everything else until an operator mints the first token. That is the
 * safe direction to fail — the alternative is a server that is wide open for exactly
 * as long as nobody has gotten around to securing it.
 */
export class TokenStore {
  readonly #db: Database.Database;
  readonly #create: Database.Statement<[name: string, hash: string, createdAt: number]>;
  readonly #find: Database.Statement<[hash: string]>;

  /**
   * Open (and create, if needed) the database at `path`. Pass {@link IN_MEMORY} for a
   * throwaway database — the default, and one that holds no tokens, so an app that was
   * given no token store of its own authorizes nothing.
   */
  constructor(path: string = IN_MEMORY) {
    this.#db = openDatabase(path);
    this.#db.exec(SCHEMA);

    this.#create = this.#db.prepare(
      `INSERT INTO tokens (name, hash, created_at) VALUES (?, ?, ?)`,
    );
    this.#find = this.#db.prepare(`SELECT 1 FROM tokens WHERE hash = ?`);
  }

  /**
   * Mint a token called `name` and return it. This is the only time it exists in a
   * readable form; the caller shows it to the operator and forgets it.
   *
   * Throws a `RangeError` for a name the store will not take, and an `Error` if that
   * name is already in use — a second `token:create pixel` should say so rather than
   * quietly mint a second token nobody can tell apart from the first.
   */
  create(name: string): string {
    if (!TOKEN_NAME_PATTERN.test(name)) throw new RangeError(TOKEN_NAME_RULE);

    const token = mintToken();
    try {
      this.#create.run(name, hashToken(token), Math.floor(Date.now() / 1000));
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new Error(`a token named "${name}" already exists`);
      }
      throw error;
    }

    return token;
  }

  /**
   * Whether `token` is one this server issued.
   *
   * The lookup is by hash, on a unique index. There is no secret-dependent comparison
   * to time: an attacker chooses the token, not the SHA-256 of it, so no amount of
   * measuring how long the index takes to miss tells them which token would hit.
   */
  verify(token: string): boolean {
    if (token.length === 0) return false;
    return this.#find.get(hashToken(token)) !== undefined;
  }

  close(): void {
    this.#db.close();
  }
}

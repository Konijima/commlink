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

/**
 * `AUTOINCREMENT` is load-bearing, not decoration. Without it SQLite reuses the row id
 * of a deleted row, so a token minted after a revoke could inherit the id — and with it
 * the spent rate-limit budget — of the token it replaced.
 */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS tokens (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL UNIQUE,
    hash       TEXT    NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  );
`;

/** One row of the `tokens` table, as SQLite spells the columns. */
interface TokenRow {
  id: number;
  name: string;
  created_at: number;
}

/**
 * A token this server issued, as {@link TokenStore.list} reports it.
 *
 * Neither the token nor its hash is here. Everything in this record is safe to print,
 * which is what lets an operator see what exists without handling a credential.
 */
export interface TokenRecord {
  /** How the rest of the server names this token; see {@link TokenStore.identify}. */
  id: number;
  /** The label it was minted under, and the handle {@link TokenStore.revoke} takes. */
  name: string;
  /** When it was minted, in whole seconds since the Unix epoch. */
  createdAt: number;
}

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
  readonly #has: Database.Statement<[id: number]>;
  readonly #list: Database.Statement<[]>;
  readonly #revoke: Database.Statement<[name: string]>;

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
    this.#find = this.#db.prepare(`SELECT id FROM tokens WHERE hash = ?`);
    this.#has = this.#db.prepare(`SELECT 1 FROM tokens WHERE id = ?`);
    // `hash` is deliberately absent: nothing that reads a token out of this store
    // should have to decide whether it may be shown.
    this.#list = this.#db.prepare(`SELECT id, name, created_at FROM tokens ORDER BY id`);
    this.#revoke = this.#db.prepare(`DELETE FROM tokens WHERE name = ?`);
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
   * Every token this server has issued, oldest first.
   *
   * A token cannot be read back out — only its hash was stored — so this is what an
   * operator has instead: the names they minted, and when. It is the list {@link revoke}
   * takes its argument from.
   */
  list(): TokenRecord[] {
    const rows = this.#list.all() as TokenRow[];

    return rows.map((row) => ({ id: row.id, name: row.name, createdAt: row.created_at }));
  }

  /**
   * Revoke the token named `name`, and report whether there was one to revoke.
   *
   * The row is deleted, so the token it stood for stops authorizing anything: every
   * request is looked up against the table as it arrives, with nothing cached in front
   * of it, and a server sharing this database sees the deletion on its very next
   * request. A token is checked when a connection is made, not for as long as it is
   * held, so a subscriber already holding a stream is not cut off by the delete alone;
   * the subscribe routes sweep their open connections against {@link has} and drop one
   * whose token has gone, within a keepalive interval of the revoke.
   *
   * `false` means no such name, which is worth telling apart from success: it is what an
   * operator who mistyped the name would otherwise never hear.
   *
   * The name is free to mint again afterwards, and the token minted under it is a new
   * token with a new id — so it starts with a fresh rate-limit budget rather than
   * inheriting whatever the revoked one had spent.
   */
  revoke(name: string): boolean {
    return this.#revoke.run(name).changes > 0;
  }

  /**
   * Which token `token` is, as the id of its row, or `null` if this server never issued
   * it. The id names a token without being one — it is what a rate limit is counted
   * against, and it can be logged where the token itself never could.
   *
   * The lookup is by hash, on a unique index. There is no secret-dependent comparison
   * to time: an attacker chooses the token, not the SHA-256 of it, so no amount of
   * measuring how long the index takes to miss tells them which token would hit.
   */
  identify(token: string): number | null {
    if (token.length === 0) return null;

    const row = this.#find.get(hashToken(token)) as { id: number } | undefined;
    return row?.id ?? null;
  }

  /** Whether `token` is one this server issued. */
  verify(token: string): boolean {
    return this.identify(token) !== null;
  }

  /**
   * Whether a token with this id is still stored. It is the check a held subscription
   * makes to notice its token was revoked out from under it: {@link identify} answers
   * that question from a token, but a connection has already resolved its token to an
   * id, so this answers it from the id — and the server never has to keep the raw token
   * around to re-check it. A revoked id is gone for good; a name minted again gets a new
   * one, so no reused id can make a dropped subscriber look authorized.
   */
  has(id: number): boolean {
    return this.#has.get(id) !== undefined;
  }

  close(): void {
    this.#db.close();
  }
}

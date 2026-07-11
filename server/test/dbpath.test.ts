import { describe, expect, it } from 'vitest';
import {
  DB_PATH_RULE,
  DEFAULT_DB_PATH,
  IN_MEMORY_DB_PATH_RULE,
  parseDbPath,
} from '../src/dbpath.js';

describe('parseDbPath', () => {
  it('defaults to the working-directory file when unset', () => {
    expect(parseDbPath(undefined)).toBe(DEFAULT_DB_PATH);
    expect(DEFAULT_DB_PATH).toBe('./commlink.sqlite');
  });

  it('passes a non-blank file path through, trimmed', () => {
    // A relative or absolute file path is not second-guessed beyond trimming stray space.
    expect(parseDbPath('./commlink.sqlite')).toBe('./commlink.sqlite');
    expect(parseDbPath('/var/lib/commlink/db.sqlite')).toBe(
      '/var/lib/commlink/db.sqlite',
    );
    expect(parseDbPath('  ./data.sqlite  ')).toBe('./data.sqlite');
  });

  it.each([
    ['an empty value', ''],
    ['whitespace that trims to nothing', '   '],
  ])('rejects %s rather than opening a throwaway database', (_case, raw) => {
    // `process.env.DB_PATH ?? DEFAULT_DB_PATH` would let each of these through as-is, and
    // SQLite opens an empty filename as a private temporary database — deleted on close, and
    // a separate one per store, so nothing persists and the token store authorizes nobody.
    expect(() => parseDbPath(raw)).toThrow(DB_PATH_RULE);
  });

  it('rejects the in-memory database, which a whole server cannot use', () => {
    // `:memory:` is a legitimate value for a *single* store (the constructors default to it
    // for tests), but the server opens a connection for messages and another for tokens, and a
    // `token:create` runs as a third process. Each in-memory connection is its own private
    // database, so none of them would share one: a `:memory:` server persists nothing and, its
    // token store starting empty and unreachable, authorizes nobody — the trap a blank path is
    // refused for, reached from the other side. It is refused for its own, named reason.
    expect(() => parseDbPath(':memory:')).toThrow(IN_MEMORY_DB_PATH_RULE);
    expect(() => parseDbPath('  :memory:  ')).toThrow(IN_MEMORY_DB_PATH_RULE);
  });
});

import { describe, expect, it } from 'vitest';
import { DEFAULT_DB_PATH, parseDbPath } from '../src/dbpath.js';

describe('parseDbPath', () => {
  it('defaults to the working-directory file when unset', () => {
    expect(parseDbPath(undefined)).toBe(DEFAULT_DB_PATH);
    expect(DEFAULT_DB_PATH).toBe('./commlink.sqlite');
  });

  it('passes a non-blank path through, trimmed', () => {
    // A relative or absolute file path is not second-guessed beyond trimming stray space;
    // the literal `:memory:` is a legitimate, deliberately ephemeral database.
    expect(parseDbPath('./commlink.sqlite')).toBe('./commlink.sqlite');
    expect(parseDbPath('/var/lib/commlink/db.sqlite')).toBe(
      '/var/lib/commlink/db.sqlite',
    );
    expect(parseDbPath(':memory:')).toBe(':memory:');
    expect(parseDbPath('  ./data.sqlite  ')).toBe('./data.sqlite');
  });

  it.each([
    ['an empty value', ''],
    ['whitespace that trims to nothing', '   '],
  ])('rejects %s rather than opening a throwaway database', (_case, raw) => {
    // `process.env.DB_PATH ?? DEFAULT_DB_PATH` would let each of these through as-is, and
    // SQLite opens an empty filename as a private temporary database — deleted on close, and
    // a separate one per store, so nothing persists and the token store authorizes nobody.
    expect(() => parseDbPath(raw)).toThrow(RangeError);
  });
});

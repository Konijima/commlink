import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { envLineRule, loadEnvFile, parseEnv } from '../src/env.js';

const tmpDirs: string[] = [];

/** Write `contents` to a `.env` in a fresh temp dir and return the path. */
function envFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'commlink-env-'));
  tmpDirs.push(dir);
  const path = join(dir, '.env');
  writeFileSync(path, contents);
  return path;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    rmSync(tmpDirs.pop() as string, { recursive: true, force: true });
  }
});

describe('parseEnv', () => {
  it('reads simple KEY=value assignments in order', () => {
    expect(parseEnv('PORT=4500\nHOST=127.0.0.1')).toEqual([
      { key: 'PORT', value: '4500' },
      { key: 'HOST', value: '127.0.0.1' },
    ]);
  });

  it('skips blank lines and full-line comments', () => {
    const contents = '# a comment\n\n   \n   # indented comment\nPORT=4500\n';
    expect(parseEnv(contents)).toEqual([{ key: 'PORT', value: '4500' }]);
  });

  it('trims surrounding whitespace on an unquoted value', () => {
    expect(parseEnv('DB_PATH=   ./commlink.sqlite   ')).toEqual([
      { key: 'DB_PATH', value: './commlink.sqlite' },
    ]);
  });

  it('keeps a quoted value verbatim, including spaces and a #', () => {
    expect(parseEnv('A="  spaced  "\nB=\'a # b\'')).toEqual([
      { key: 'A', value: '  spaced  ' },
      { key: 'B', value: 'a # b' },
    ]);
  });

  it('does not strip an inline # from an unquoted value', () => {
    // A `#` mid-value belongs to the value — a token or a path may contain one.
    expect(parseEnv('TOKEN=ab#cd')).toEqual([{ key: 'TOKEN', value: 'ab#cd' }]);
  });

  it('keeps an = that appears in the value', () => {
    expect(parseEnv('URL=a=b=c')).toEqual([{ key: 'URL', value: 'a=b=c' }]);
  });

  it('does not treat a lone quote as a wrapping pair', () => {
    expect(parseEnv('A="only-leading')).toEqual([{ key: 'A', value: '"only-leading' }]);
  });

  it('tolerates CRLF line endings', () => {
    expect(parseEnv('PORT=4500\r\nHOST=localhost\r\n')).toEqual([
      { key: 'PORT', value: '4500' },
      { key: 'HOST', value: 'localhost' },
    ]);
  });

  it('accepts an empty value', () => {
    expect(parseEnv('EMPTY=')).toEqual([{ key: 'EMPTY', value: '' }]);
  });

  it('throws naming the line for a line with no =', () => {
    expect(() => parseEnv('PORT=4500\ngarbage')).toThrow(envLineRule(2));
  });

  it('throws for a key that is not a shell identifier', () => {
    expect(() => parseEnv('1PORT=4500')).toThrow(envLineRule(1));
    expect(() => parseEnv('a.b=c')).toThrow(envLineRule(1));
    expect(() => parseEnv('a b=c')).toThrow(envLineRule(1));
  });
});

describe('loadEnvFile', () => {
  it('applies each key to the given environment', () => {
    const env: NodeJS.ProcessEnv = {};
    const result = loadEnvFile({ path: envFile('PORT=4500\nHOST=127.0.0.1'), env });

    expect(env.PORT).toBe('4500');
    expect(env.HOST).toBe('127.0.0.1');
    expect(result).toEqual({ applied: ['PORT', 'HOST'], skipped: [] });
  });

  it('lets a real environment variable win over the file', () => {
    const env: NodeJS.ProcessEnv = { PORT: '9999' };
    const result = loadEnvFile({ path: envFile('PORT=4500\nHOST=127.0.0.1'), env });

    // The already-set value is untouched; only the new key is applied.
    expect(env.PORT).toBe('9999');
    expect(env.HOST).toBe('127.0.0.1');
    expect(result).toEqual({ applied: ['HOST'], skipped: ['PORT'] });
  });

  it('does nothing for a missing file', () => {
    const env: NodeJS.ProcessEnv = {};
    const result = loadEnvFile({ path: join(tmpdir(), 'commlink-does-not-exist', '.env'), env });

    expect(env).toEqual({});
    expect(result).toEqual({ applied: [], skipped: [] });
  });

  it('propagates a parse error for a malformed file that exists', () => {
    const env: NodeJS.ProcessEnv = {};
    expect(() => loadEnvFile({ path: envFile('PORT=4500\ngarbage'), env })).toThrow(
      envLineRule(2),
    );
  });

  it('leaves an empty value distinguishable from an unset one', () => {
    const env: NodeJS.ProcessEnv = {};
    loadEnvFile({ path: envFile('EMPTY='), env });
    expect(env.EMPTY).toBe('');
  });
});

import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TOKEN_NAME_RULE, TokenStore, hashToken } from '../src/tokens.js';

const execFileAsync = promisify(execFile);

/** The package root, so the commands run where their `tsx` and `node_modules` are. */
const SERVER_DIR = fileURLToPath(new URL('..', import.meta.url));

/** A minted token: 32 base64url-encoded bytes, alone on a line. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}\n$/;

/** `id<TAB>name<TAB>2026-07-10T12:00:00Z` */
const LISTING_PATTERN = /^(\d+)\t([A-Za-z0-9_-]+)\t(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)$/;

interface Outcome {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * The token commands are scripts, and what they promise an operator is an exit code and
 * a strict split between stdout and stderr. Neither survives being imported into the
 * test process — `process.exit` would take the runner down with it — so each one is run
 * the way an operator runs it: as its own process, through `tsx`, as `pnpm token:*` does.
 */
describe('the token commands', () => {
  let directory: string;
  let dbPath: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'commlink-cli-'));
    dbPath = join(directory, 'commlink.sqlite');
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  async function token(command: string, ...args: string[]): Promise<Outcome> {
    const script = join('src', 'cli', `token-${command}.ts`);
    try {
      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        ['--import', 'tsx', script, ...args],
        { cwd: SERVER_DIR, env: { ...process.env, DB_PATH: dbPath } },
      );
      return { status: 0, stdout, stderr };
    } catch (error) {
      // A non-zero exit rejects, carrying everything the process managed to write.
      const failed = error as { code?: number; stdout?: string; stderr?: string };
      return { status: failed.code ?? -1, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' };
    }
  }

  /** Read the database back with no help from the commands that wrote it. */
  function inspect<T>(read: (tokens: TokenStore) => T): T {
    const tokens = new TokenStore(dbPath);
    try {
      return read(tokens);
    } finally {
      tokens.close();
    }
  }

  describe('token:create', () => {
    it('prints the minted token on stdout, alone', async () => {
      const created = await token('create', 'pixel');

      expect(created.status).toBe(0);
      // Everything else it says goes to stderr, which is what lets a caller write
      // `TOKEN=$(pnpm --silent token:create pixel)` and capture only the token.
      expect(created.stdout).toMatch(TOKEN_PATTERN);
      expect(created.stderr).toContain('pixel');
    });

    it('mints a token the server accepts', async () => {
      const created = await token('create', 'pixel');

      expect(inspect((tokens) => tokens.verify(created.stdout.trim()))).toBe(true);
    });

    it('refuses a name already in use, and mints nothing', async () => {
      await token('create', 'pixel');
      const again = await token('create', 'pixel');

      expect(again.status).toBe(1);
      expect(again.stderr).toContain('already exists');
      expect(again.stdout).toBe('');
      expect(inspect((tokens) => tokens.list())).toHaveLength(1);
    });

    it('refuses a name the store would not take', async () => {
      const created = await token('create', 'has space');

      expect(created.status).toBe(1);
      expect(created.stderr).toContain(TOKEN_NAME_RULE);
    });

    it.each<[string, string[]]>([
      ['no name', []],
      ['an empty name, as an unset shell variable expands to', ['']],
    ])('refuses %s', async (_case, args) => {
      const created = await token('create', ...args);

      expect(created.status).toBe(1);
      expect(created.stderr).toContain('usage: token:create <name>');
    });

    it('refuses two names rather than silently minting the first', async () => {
      const created = await token('create', 'pixel', 'laptop');

      expect(created.status).toBe(1);
      expect(created.stderr).toContain('one name at a time');
      expect(inspect((tokens) => tokens.list())).toEqual([]);
    });
  });

  describe('token:list', () => {
    it('says so when there is nothing to list', async () => {
      const listed = await token('list');

      expect(listed.status).toBe(0);
      expect(listed.stdout).toBe('');
      expect(listed.stderr).toContain('No tokens');
    });

    it('prints one token per line, oldest first', async () => {
      await token('create', 'pixel');
      await token('create', 'laptop');

      const listed = await token('list');
      expect(listed.status).toBe(0);

      const rows = listed.stdout.trimEnd().split('\n');
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => LISTING_PATTERN.exec(row)?.[2])).toEqual(['pixel', 'laptop']);
    });

    it('names each token by the id the rest of the server knows it as', async () => {
      await token('create', 'pixel');

      const [row] = (await token('list')).stdout.trimEnd().split('\n');
      const id = Number(LISTING_PATTERN.exec(row)?.[1]);

      expect(id).toBe(inspect((tokens) => tokens.list()[0].id));
    });

    it('prints neither the token nor its hash', async () => {
      const minted = (await token('create', 'pixel')).stdout.trim();

      // The whole point of a listing an operator can paste anywhere.
      const listed = await token('list');
      expect(listed.stdout + listed.stderr).not.toContain(minted);
      expect(listed.stdout + listed.stderr).not.toContain(hashToken(minted));
    });

    it('takes no arguments', async () => {
      const listed = await token('list', 'pixel');

      expect(listed.status).toBe(1);
      expect(listed.stderr).toContain('usage: token:list');
    });
  });

  describe('token:revoke', () => {
    it('revokes the named token, and leaves the others alone', async () => {
      const pixel = (await token('create', 'pixel')).stdout.trim();
      const laptop = (await token('create', 'laptop')).stdout.trim();

      const revoked = await token('revoke', 'pixel');
      expect(revoked.status).toBe(0);
      expect(revoked.stderr).toContain('pixel');

      expect(inspect((tokens) => tokens.verify(pixel))).toBe(false);
      expect(inspect((tokens) => tokens.verify(laptop))).toBe(true);
      expect(inspect((tokens) => tokens.list().map((record) => record.name))).toEqual([
        'laptop',
      ]);
    });

    it('refuses a name that was never minted, rather than reporting success', async () => {
      const pixel = (await token('create', 'pixel')).stdout.trim();

      // A mistyped name must not look like a token successfully revoked.
      const revoked = await token('revoke', 'pxiel');
      expect(revoked.status).toBe(1);
      expect(revoked.stderr).toContain('no token named "pxiel"');
      expect(inspect((tokens) => tokens.verify(pixel))).toBe(true);
    });

    it('refuses a name it already revoked', async () => {
      await token('create', 'pixel');
      await token('revoke', 'pixel');

      expect((await token('revoke', 'pixel')).status).toBe(1);
    });

    it.each<[string, string[]]>([
      ['no name', []],
      ['an empty name', ['']],
    ])('refuses %s', async (_case, args) => {
      const revoked = await token('revoke', ...args);

      expect(revoked.status).toBe(1);
      expect(revoked.stderr).toContain('usage: token:revoke <name>');
    });

    it('frees the name, and the replacement is a different token', async () => {
      const first = (await token('create', 'pixel')).stdout.trim();
      await token('revoke', 'pixel');

      const created = await token('create', 'pixel');
      expect(created.status).toBe(0);

      const second = created.stdout.trim();
      expect(second).not.toBe(first);
      expect(inspect((tokens) => tokens.verify(first))).toBe(false);
      expect(inspect((tokens) => tokens.verify(second))).toBe(true);
    });
  });

  it('reads and writes the one database DB_PATH names', async () => {
    // Three commands, three processes, one file — and it is the file the server opens.
    // A command pointed somewhere else would mint tokens that authorize nothing.
    await token('create', 'pixel');
    expect((await token('list')).stdout).toContain('pixel');

    await token('revoke', 'pixel');
    expect((await token('list')).stderr).toContain('No tokens');
  });
});

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DB_PATH_RULE } from '../src/dbpath.js';
import { TOKEN_NAME_RULE, TokenStore, hashToken } from '../src/tokens.js';

const execFileAsync = promisify(execFile);

/** The package root, so the commands run where their `tsx` and `node_modules` are. */
const SERVER_DIR = fileURLToPath(new URL('..', import.meta.url));

/** A minted token: 32 base64url-encoded bytes, alone on a line. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}\n$/;

/** `id<TAB>name<TAB>2026-07-10T12:00:00Z` */
const LISTING_PATTERN =
  /^(\d+)\t([A-Za-z0-9_-]+)\t(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)$/;

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

  /** Run a token command with an explicit environment, as an operator's shell would. */
  async function run(
    env: NodeJS.ProcessEnv,
    command: string,
    args: string[],
  ): Promise<Outcome> {
    const script = join('src', 'cli', `token-${command}.ts`);
    try {
      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        ['--import', 'tsx', script, ...args],
        { cwd: SERVER_DIR, env },
      );
      return { status: 0, stdout, stderr };
    } catch (error) {
      // A non-zero exit rejects, carrying everything the process managed to write.
      const failed = error as { code?: number; stdout?: string; stderr?: string };
      return {
        status: failed.code ?? -1,
        stdout: failed.stdout ?? '',
        stderr: failed.stderr ?? '',
      };
    }
  }

  async function token(command: string, ...args: string[]): Promise<Outcome> {
    return run({ ...process.env, DB_PATH: dbPath }, command, args);
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

    it('closes the database even when the mint is refused', async () => {
      // `fail` exits the process, and an exiting process runs no `finally` — so reporting
      // the error from inside the `try` would skip the `tokens.close()` in the `finally`
      // and leave the store open, exactly the hazard token:revoke is structured around. A
      // left-open connection strands a `-wal` sidecar on disk uncheckpointed; the last
      // connection closing checkpoints it into the main file and removes it. So an absent
      // `-wal` after a refused create is the observable proof the store was closed on the
      // error path too — the same check the server's clean shutdown makes (shutdown.test.ts).
      const created = await token('create', 'has space');

      expect(created.status).toBe(1);
      expect(created.stderr).toContain(TOKEN_NAME_RULE);
      // The constructor opened the database and wrote the schema — a write the connection
      // holds in the WAL — before the bad name was refused, so a store left open would
      // strand the sidecar here.
      expect(existsSync(dbPath)).toBe(true);
      expect(existsSync(`${dbPath}-wal`)).toBe(false);
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
      expect(rows.map((row) => LISTING_PATTERN.exec(row)?.[2])).toEqual([
        'pixel',
        'laptop',
      ]);
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

      // The guidance must match what the server actually does: an open subscriber is
      // swept off within a keepalive interval, so no restart is needed. It used to claim
      // the opposite — that a subscriber keeps its stream until it disconnects and a
      // restart is required — which contradicted the revocation sweep (see revocation.test.ts).
      expect(revoked.stderr).toContain('no restart needed');
      expect(revoked.stderr).not.toContain('until it disconnects');

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

  // The server loads a `.env` from its working directory before it reads DB_PATH
  // (server.ts), so an operator who sets DB_PATH only in `.env` — the documented way, via
  // `.env.example` — points the server at that database. A command that read only the
  // process environment would resolve DB_PATH to the default `./commlink.sqlite` and mint
  // into a different file than the server ever opens: a server that authorizes nobody,
  // holding a token that works nowhere — exactly the split resolving both through one path
  // is meant to prevent. So the commands load `.env` the same way, from the same cwd.
  describe('picks up DB_PATH from a .env file the way the server does', () => {
    /** The `.bin/tsx` shim, run from `cwd` so its `.env` is the one in `cwd`. */
    const TSX = join(SERVER_DIR, 'node_modules', '.bin', 'tsx');

    async function runIn(
      cwd: string,
      env: NodeJS.ProcessEnv,
      command: string,
      args: string[],
    ): Promise<Outcome> {
      const script = join(SERVER_DIR, 'src', 'cli', `token-${command}.ts`);
      try {
        const { stdout, stderr } = await execFileAsync(TSX, [script, ...args], {
          cwd,
          env,
        });
        return { status: 0, stdout, stderr };
      } catch (error) {
        const failed = error as { code?: number; stdout?: string; stderr?: string };
        return {
          status: failed.code ?? -1,
          stdout: failed.stdout ?? '',
          stderr: failed.stderr ?? '',
        };
      }
    }

    /** The environment a bare `pnpm token:*` runs in, with DB_PATH set nowhere but `.env`. */
    function envWithoutDbPath(): NodeJS.ProcessEnv {
      const env = { ...process.env };
      delete env.DB_PATH;
      return env;
    }

    /** Read a database back with no help from the command that wrote it. */
    function inspectAt<T>(path: string, read: (tokens: TokenStore) => T): T {
      const tokens = new TokenStore(path);
      try {
        return read(tokens);
      } finally {
        tokens.close();
      }
    }

    it('mints into the database its .env names, not the default', async () => {
      const fromEnv = join(directory, 'from-env.sqlite');
      await writeFile(join(directory, '.env'), `DB_PATH=${fromEnv}\n`);

      const created = await runIn(directory, envWithoutDbPath(), 'create', ['pixel']);
      expect(created.status).toBe(0);
      expect(created.stdout).toMatch(TOKEN_PATTERN);

      // The token is in the file the server would open from the same `.env`...
      expect(inspectAt(fromEnv, (tokens) => tokens.verify(created.stdout.trim()))).toBe(
        true,
      );
      // ...and the default `./commlink.sqlite`, relative to the cwd, was never touched.
      expect(existsSync(join(directory, 'commlink.sqlite'))).toBe(false);
    });

    it('lets a real DB_PATH env var win over the .env value, as the server does', async () => {
      const fromEnv = join(directory, 'from-env.sqlite');
      const fromVar = join(directory, 'from-var.sqlite');
      await writeFile(join(directory, '.env'), `DB_PATH=${fromEnv}\n`);

      const env = envWithoutDbPath();
      env.DB_PATH = fromVar;
      const created = await runIn(directory, env, 'create', ['pixel']);
      expect(created.status).toBe(0);

      expect(inspectAt(fromVar, (tokens) => tokens.verify(created.stdout.trim()))).toBe(
        true,
      );
      // The `.env` value lost, so its database was never opened.
      expect(existsSync(fromEnv)).toBe(false);
    });

    it('refuses a malformed .env rather than resolving past it, naming the command', async () => {
      // The server aborts on a `.env` it cannot parse; a command that shares the file must
      // not read past a broken one to a default, or it would mint where the server refuses
      // to boot. `token:list` reaches the same resolver, so it stands in for all three.
      await writeFile(join(directory, '.env'), 'this is not KEY=value\n');

      const listed = await runIn(directory, envWithoutDbPath(), 'list', []);
      expect(listed.status).toBe(1);
      expect(listed.stderr).toContain('token:list');
      expect(listed.stderr).toContain('.env line 1');
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

  // A command must resolve DB_PATH exactly as the server does — refusing a blank or
  // whitespace-only value — or it mints tokens into a database the server never reads.
  // The raw `process.env.DB_PATH ?? default` this once used let both slip through: an
  // empty string is not nullish, so the default never filled it in, and SQLite opened
  // the empty filename as a private throwaway database while the server refused to boot.
  describe('resolves DB_PATH the way the server does', () => {
    it.each<[string, string]>([
      ['a blank', ''],
      ['a whitespace-only', '   '],
    ])(
      'refuses %s DB_PATH on token:create rather than minting into a throwaway database',
      async (_case, value) => {
        const created = await run({ ...process.env, DB_PATH: value }, 'create', [
          'pixel',
        ]);

        expect(created.status).toBe(1);
        expect(created.stderr).toContain('token:create');
        expect(created.stderr).toContain(DB_PATH_RULE);
        // Nothing minted: an operator must not walk away with a token from a database
        // that was never opened.
        expect(created.stdout).toBe('');
      },
    );

    it('refuses a blank DB_PATH on token:list too', async () => {
      const listed = await run({ ...process.env, DB_PATH: '' }, 'list', []);

      expect(listed.status).toBe(1);
      expect(listed.stderr).toContain('token:list');
      expect(listed.stderr).toContain(DB_PATH_RULE);
    });

    it('refuses a blank DB_PATH on token:revoke too', async () => {
      const revoked = await run({ ...process.env, DB_PATH: '' }, 'revoke', ['pixel']);

      expect(revoked.status).toBe(1);
      expect(revoked.stderr).toContain('token:revoke');
      expect(revoked.stderr).toContain(DB_PATH_RULE);
    });
  });
});

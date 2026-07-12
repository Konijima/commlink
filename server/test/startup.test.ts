import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DB_PATH_RULE, IN_MEMORY_DB_PATH_RULE } from '../src/dbpath.js';
import { HOST_RULE } from '../src/host.js';
import { logLevelRule } from '../src/logging.js';
import { PORT_RULE } from '../src/port.js';
import { RETENTION_RULE } from '../src/retention.js';
import { SUBPROCESS_TIMEOUT_MS } from './helpers.js';

// Every test in this file runs the entrypoint as its own process, so they all need the
// budget a spawn takes rather than the one in-process work does.
vi.setConfig({ testTimeout: SUBPROCESS_TIMEOUT_MS });

const execFileAsync = promisify(execFile);

/** The package root, so the entrypoint runs where its `tsx` and `node_modules` are. */
const SERVER_DIR = fileURLToPath(new URL('..', import.meta.url));

interface Outcome {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * The parser rejecting a bad config is one thing; the process an operator actually runs
 * exiting non-zero with the reason on its stderr is another, and only the second is what a
 * misconfigured deployment meets. So the entrypoint is run the way a service manager runs
 * it — as its own process, through `tsx`, as `pnpm start` does — and its exit and stderr
 * are read back. A malformed value is refused before the server ever binds a port, so the
 * process exits on its own; a green run means nothing is left listening.
 */
describe('the server entrypoint refuses a bad config', () => {
  let directory: string;
  let dbPath: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'commlink-startup-'));
    dbPath = join(directory, 'commlink.sqlite');
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  /**
   * Start `src/server.ts` with `env` layered over the ambient environment and wait for it
   * to exit. `DB_PATH` points at the throwaway directory so a boot that somehow got past
   * the config gate leaves nothing behind. The refusals under test exit before the store is
   * opened, so no database is written and the process never listens.
   */
  async function start(env: Record<string, string>): Promise<Outcome> {
    try {
      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        ['--import', 'tsx', join('src', 'server.ts')],
        { cwd: SERVER_DIR, env: { ...process.env, DB_PATH: dbPath, ...env } },
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

  it.each<[string, string]>([
    ['zero, which would never expire anything', '0'],
    ['a fraction of an hour', '1.5'],
    ['exponent notation Number would take', '1e3'],
    ['hex Number would take', '0x10'],
    ['a non-number', 'abc'],
    ['whitespace that trims to nothing', '   '],
  ])('exits non-zero naming the rule for %s', async (_case, value) => {
    const outcome = await start({ RETENTION_HOURS: value });

    expect(outcome.status).not.toBe(0);
    // The reason is on stderr, tagged with the variable, so the operator learns both what is
    // wrong and which setting to fix — not a bare stack trace or a silent default.
    expect(outcome.stderr).toContain('RETENTION_HOURS:');
    expect(outcome.stderr).toContain(RETENTION_RULE);
    expect(outcome.stdout).toBe('');
  });

  it.each<[string, string]>([
    ['a non-number Number would take as NaN', 'abc'],
    ['a fraction listen refuses', '8080.5'],
    ['a negative', '-1'],
    ['a port past the 16-bit range', '65536'],
    ['exponent notation Number would take', '1e3'],
    ['hex Number would take', '0x10'],
    ['whitespace that trims to nothing', '   '],
  ])('exits non-zero naming the rule for a PORT that is %s', async (_case, value) => {
    const outcome = await start({ PORT: value });

    expect(outcome.status).not.toBe(0);
    // The reason names PORT itself, so the operator learns both what is wrong and which
    // setting to fix — not the ERR_SOCKET_BAD_PORT stack trace listen would otherwise throw
    // only after the database had been opened.
    expect(outcome.stderr).toContain(PORT_RULE);
    expect(outcome.stdout).toBe('');
  });

  it.each<[string, string]>([
    ['an empty value', ''],
    ['whitespace that trims to nothing', '   '],
  ])('exits non-zero naming the rule for a HOST that is %s', async (_case, value) => {
    const outcome = await start({ HOST: value });

    expect(outcome.status).not.toBe(0);
    // A blank HOST is not caught by `?? DEFAULT_HOST` and reaches `listen` as "unspecified",
    // which binds every interface — a silent public bind. The reason names HOST so the
    // operator fixes the setting rather than discovering the exposure.
    expect(outcome.stderr).toContain(HOST_RULE);
    expect(outcome.stdout).toBe('');
  });

  it.each<[string, string]>([
    ['an empty value', ''],
    ['whitespace that trims to nothing', '   '],
  ])('exits non-zero naming the rule for a DB_PATH that is %s', async (_case, value) => {
    const outcome = await start({ DB_PATH: value });

    expect(outcome.status).not.toBe(0);
    // A blank DB_PATH is not caught by `?? DEFAULT_DB_PATH` and reaches SQLite, which opens
    // an empty filename as a private temporary database — silently ephemeral, and a separate
    // one per store. The reason names DB_PATH so the operator fixes the setting rather than
    // discovering the data loss. No database file lands in the throwaway directory: the
    // refusal exits before either store is opened.
    expect(outcome.stderr).toContain(DB_PATH_RULE);
    expect(outcome.stdout).toBe('');
    expect(await readdir(directory)).toStrictEqual([]);
  });

  it('exits non-zero naming the rule for a DB_PATH of :memory:', async () => {
    const outcome = await start({ DB_PATH: ':memory:' });

    expect(outcome.status).not.toBe(0);
    // `:memory:` is non-blank, so it clears the blank-path gate — but the server opens a
    // connection for messages and another for tokens, and each in-memory connection is its own
    // private database, so neither store would share one and `token:create` (a third process)
    // reaches yet another: a `:memory:` server persists nothing and authorizes nobody. It is
    // refused for its own named reason, before either store is opened, so the dir stays empty.
    expect(outcome.stderr).toContain(IN_MEMORY_DB_PATH_RULE);
    expect(outcome.stderr).not.toContain(DB_PATH_RULE);
    expect(outcome.stdout).toBe('');
    expect(await readdir(directory)).toStrictEqual([]);
  });

  it('does not refuse a valid DB_PATH for the db-path reason', async () => {
    // A real path must clear the db-path gate. Pairing it with a bad LOG_LEVEL makes the boot
    // fail for that later reason instead, so the process still exits promptly to assert on —
    // but if the db-path parser rejected a good value, this would fail on the wrong message.
    // `start` already sets DB_PATH to the throwaway file, so this leans on the default path.
    const outcome = await start({ LOG_LEVEL: 'nonsense' });

    expect(outcome.status).not.toBe(0);
    expect(outcome.stderr).not.toContain(DB_PATH_RULE);
    expect(outcome.stderr).toContain(logLevelRule());
  });

  it('does not refuse a valid HOST for the host reason', async () => {
    // A real address must clear the host gate. Pairing it with a bad LOG_LEVEL makes the boot
    // fail for that later reason instead, so the process still exits promptly to assert on —
    // but if the host parser rejected a good value, this would fail on the wrong message.
    const outcome = await start({ HOST: '127.0.0.1', LOG_LEVEL: 'nonsense' });

    expect(outcome.status).not.toBe(0);
    expect(outcome.stderr).not.toContain(HOST_RULE);
    expect(outcome.stderr).toContain(logLevelRule());
  });

  it('does not refuse a valid PORT for the port reason', async () => {
    // A valid port must clear the port gate. Pairing it with a bad LOG_LEVEL makes the boot
    // fail for that later reason instead, so the process still exits promptly to assert on —
    // but if the port parser rejected a good value, this would fail on the wrong message.
    const outcome = await start({ PORT: '8080', LOG_LEVEL: 'nonsense' });

    expect(outcome.status).not.toBe(0);
    expect(outcome.stderr).not.toContain(PORT_RULE);
    expect(outcome.stderr).toContain(logLevelRule());
  });

  it('does not refuse a valid RETENTION_HOURS for the retention reason', async () => {
    // A valid window must clear the retention gate. Pairing it with a bad LOG_LEVEL makes the
    // boot fail for that later reason instead, so the process still exits promptly to assert
    // on — but if the retention parser rejected a good value, this would fail on the wrong
    // message, which keeps the refusal above honest rather than "refuses everything".
    const outcome = await start({ RETENTION_HOURS: '48', LOG_LEVEL: 'nonsense' });

    expect(outcome.status).not.toBe(0);
    expect(outcome.stderr).not.toContain('RETENTION_HOURS:');
    expect(outcome.stderr).toContain(logLevelRule());
  });
});

import { type ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { installShutdownHandlers } from '../src/shutdown.js';
import { TokenStore } from '../src/tokens.js';
import { bearer } from './helpers.js';

/** RFC 6455 close code the peer reports when a close frame carried no status. */
const CLOSE_NO_STATUS = 1005;
/** RFC 6455 code the peer reports when the socket was severed with no close frame. */
const CLOSE_ABNORMAL = 1006;

/**
 * A stand-in for `process`: it emits signals the way the real one does and records the
 * exit code instead of taking the test runner down. The first `exit` wins, as a real one
 * would — the loser here is a force-exit timer racing a close that already resolved.
 */
class FakeProcess extends EventEmitter {
  exitCode: number | null = null;

  readonly exit = (code = 0): never => {
    if (this.exitCode === null) this.exitCode = code;
    return undefined as never;
  };
}

/** A minimal `app` whose only method the module touches is `close`. */
function fakeApp(close: () => Promise<void>): FastifyInstance {
  return { close } as unknown as FastifyInstance;
}

function install(
  app: FastifyInstance,
  proc: FakeProcess,
  options: { timeoutMs?: number } = {},
): () => void {
  return installShutdownHandlers(app, {
    process: proc as unknown as NodeJS.Process,
    log: () => {},
    timeoutMs: options.timeoutMs,
  });
}

describe('installShutdownHandlers', () => {
  it('closes the app and exits 0 on SIGTERM', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const proc = new FakeProcess();
    install(fakeApp(close), proc);

    proc.emit('SIGTERM');

    await vi.waitFor(() => expect(proc.exitCode).toBe(0));
    expect(close).toHaveBeenCalledOnce();
  });

  it('also shuts down on SIGINT', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const proc = new FakeProcess();
    install(fakeApp(close), proc);

    proc.emit('SIGINT');

    await vi.waitFor(() => expect(proc.exitCode).toBe(0));
    expect(close).toHaveBeenCalledOnce();
  });

  it('exits non-zero when the close fails', async () => {
    const close = vi.fn().mockRejectedValue(new Error('boom'));
    const proc = new FakeProcess();
    install(fakeApp(close), proc);

    proc.emit('SIGTERM');

    await vi.waitFor(() => expect(proc.exitCode).toBe(1));
  });

  it('ignores a second signal while the first close is still draining', async () => {
    // A close that never settles, so the shutdown stays in flight across both signals.
    const close = vi.fn().mockReturnValue(new Promise<void>(() => {}));
    const proc = new FakeProcess();
    install(fakeApp(close), proc);

    proc.emit('SIGTERM');
    proc.emit('SIGINT');

    expect(close).toHaveBeenCalledOnce();
    expect(proc.exitCode).toBeNull();
  });

  it('force-exits non-zero if the close never finishes', async () => {
    vi.useFakeTimers();
    try {
      const close = vi.fn().mockReturnValue(new Promise<void>(() => {}));
      const proc = new FakeProcess();
      install(fakeApp(close), proc, { timeoutMs: 5_000 });

      proc.emit('SIGTERM');
      expect(proc.exitCode).toBeNull();

      vi.advanceTimersByTime(5_000);
      expect(proc.exitCode).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops handling signals once disposed', () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const proc = new FakeProcess();
    const dispose = install(fakeApp(close), proc);

    dispose();
    proc.emit('SIGTERM');

    expect(close).not.toHaveBeenCalled();
    expect(proc.listenerCount('SIGTERM')).toBe(0);
    expect(proc.listenerCount('SIGINT')).toBe(0);
  });
});

/** The package root, so the spawned server finds its `tsx` and `node_modules`. */
const SERVER_DIR = fileURLToPath(new URL('..', import.meta.url));

/** Resolve to the address the server logs, or reject if it dies or never listens. */
function waitForListening(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = '';
    const onData = (chunk: Buffer): void => {
      out += chunk.toString();
      const match = out.match(/listening on (http:\/\/\S+)/);
      if (match) {
        child.stdout?.off('data', onData);
        resolve(match[1]);
      }
    };
    child.stdout?.on('data', onData);
    child.once('exit', (code) => reject(new Error(`server exited early with ${code}`)));
  });
}

describe('the server process shuts down gracefully on SIGTERM', () => {
  let directory: string;
  let child: ChildProcess | undefined;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'commlink-shutdown-'));
  });

  afterEach(async () => {
    if (child && child.exitCode === null) child.kill('SIGKILL');
    await rm(directory, { recursive: true, force: true });
  });

  it('closes an open subscriber and exits 0', async () => {
    // Seed a token the spawned server will authenticate the subscriber against.
    const dbPath = join(directory, 'commlink.sqlite');
    const seed = new TokenStore(dbPath);
    const token = seed.create('test');
    seed.close();

    // Port 0 lets the OS pick a free port, so the test never collides with a real server.
    child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
      cwd: SERVER_DIR,
      env: { ...process.env, DB_PATH: dbPath, PORT: '0', HOST: '127.0.0.1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const address = await waitForListening(child);
    const socket = new WebSocket(`${address.replace(/^http/, 'ws')}/test/ws`, {
      headers: bearer(token),
    });

    const closeCode = new Promise<number>((resolve) => {
      socket.once('close', (code) => resolve(code));
    });
    const exitCode = new Promise<number | null>((resolve) => {
      child?.once('exit', (code) => resolve(code));
    });

    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });

    child.kill('SIGTERM');

    // The subscriber is closed with a close frame (not a severed socket), and the process
    // stops of its own accord with a success code — the two halves of a clean shutdown.
    expect(await closeCode).not.toBe(CLOSE_ABNORMAL);
    expect(await closeCode).toBe(CLOSE_NO_STATUS);
    expect(await exitCode).toBe(0);
  }, 20_000);
});

/**
 * Boot the compiled server and check that it answers.
 *
 * `typecheck` and `test` both run the TypeScript sources through a loader that
 * resolves imports the way a bundler would. Node's ESM loader is stricter, so a
 * build can typecheck, test green, and still fail to start. Nothing catches that
 * except starting it, which is what this does.
 *
 * Run it after `pnpm build`. Exits non-zero, printing the server's own output, if
 * the process dies or `/healthz` does not come back healthy.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_DIR = fileURLToPath(new URL('..', import.meta.url));
const ENTRYPOINT = join(SERVER_DIR, 'dist', 'server.js');
const BOOT_TIMEOUT_MS = 15_000;

/** The line `server.ts` prints once it is listening, e.g. `… on http://127.0.0.1:4500`. */
const LISTENING = /listening on (\S+)/;

/** Set once the server is spawned, so a later failure can still reap it. */
let server;
/** Everything the server has written, printed only when something goes wrong. */
let output = '';

function fail(message) {
  console.error(`smoke: ${message}`);
  if (output.trim().length > 0) {
    console.error('--- server output ---');
    console.error(output.trimEnd());
    console.error('---------------------');
  }
  // There is no graceful shutdown yet, so there is nothing to wait for.
  server?.kill('SIGKILL');
  process.exit(1);
}

if (!existsSync(ENTRYPOINT)) {
  fail(`no build at ${ENTRYPOINT} — run \`pnpm build\` first`);
}

// A throwaway database, and port 0 so the OS picks a free port: a smoke run must not
// collide with a dev server, and must not leave a file behind.
const dataDir = await mkdtemp(join(tmpdir(), 'commlink-smoke-'));
server = spawn(process.execPath, [ENTRYPOINT], {
  cwd: SERVER_DIR,
  env: {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: '0',
    DB_PATH: join(dataDir, 'smoke.sqlite'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

server.stdout.on('data', (chunk) => (output += chunk));
server.stderr.on('data', (chunk) => (output += chunk));

/** Resolve with the server's address, or reject if it dies or never gets there. */
const address = await new Promise((resolve, reject) => {
  const timer = setTimeout(
    () => reject(new Error(`did not start within ${BOOT_TIMEOUT_MS}ms`)),
    BOOT_TIMEOUT_MS,
  );

  const settle = (fn, value) => {
    clearTimeout(timer);
    fn(value);
  };

  // The failure this script exists to catch: the process exits before it listens.
  server.on('exit', (code, signal) =>
    settle(reject, new Error(`exited (code ${code}, signal ${signal}) before listening`)),
  );
  server.on('error', (error) => settle(reject, error));
  server.stdout.on('data', () => {
    const match = LISTENING.exec(output);
    if (match) settle(resolve, match[1]);
  });
}).catch((error) => fail(error.message));

let healthz;
try {
  const response = await fetch(new URL('/healthz', address));
  healthz = { status: response.status, body: await response.json() };
} catch (error) {
  fail(`GET /healthz failed: ${error.message}`);
}

if (healthz.status !== 200 || healthz.body?.status !== 'ok') {
  fail(`GET /healthz -> ${healthz.status} ${JSON.stringify(healthz.body)}`);
}

server.kill('SIGKILL');
await rm(dataDir, { recursive: true, force: true });

console.log(`smoke: ${address} -> GET /healthz 200 ${JSON.stringify(healthz.body)}`);

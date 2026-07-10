import type { FastifyInstance } from 'fastify';

/** The signals that ask a process to stop, and that we turn into a graceful close. */
const DEFAULT_SIGNALS: readonly NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];

/**
 * How long a graceful close is given before it is abandoned. A subscriber that will not
 * drain, or a database wedged mid-write, must not be able to hold the process up forever.
 */
const DEFAULT_TIMEOUT_MS = 10_000;

export interface ShutdownOptions {
  /** Which signals begin a shutdown. Defaults to `SIGTERM` and `SIGINT`. */
  signals?: readonly NodeJS.Signals[];
  /**
   * How long to wait for {@link FastifyInstance.close} before giving up and exiting
   * non-zero, so a supervisor sees the stop was not clean. Defaults to 10s.
   */
  timeoutMs?: number;
  /**
   * The process to listen on and exit through. Injected so a test can drive shutdown
   * without forking a child and without taking the test runner down with `process.exit`.
   */
  process?: Pick<NodeJS.Process, 'on' | 'off' | 'exit'>;
  /** Where the shutdown line is written. Defaults to `console.error` (stderr). */
  log?: (message: string) => void;
}

/**
 * Close `app` gracefully when the process is asked to stop.
 *
 * On `SIGTERM` or `SIGINT` the HTTP server stops accepting new connections, every open
 * subscriber stream is ended — the WebSocket clients by `@fastify/websocket`, the
 * `/json` responses by the stream route's `preClose` hook — and the databases are closed,
 * then the process exits `0`. Without this a restart kills the process outright: every
 * subscriber's connection is severed with no close frame, so each client only discovers
 * the drop by its own timeout rather than being told to reconnect.
 *
 * A close that wedges is bounded by `timeoutMs`, after which the process exits non-zero
 * so a supervisor sees the stop was unclean. A second signal arriving mid-shutdown is the
 * operator growing impatient, not a fresh request, and is ignored so the close is not
 * restarted under itself.
 *
 * Returns a function that removes the handlers again — unused by the entrypoint, but what
 * lets a test install and tear down without leaking listeners onto the real process.
 */
export function installShutdownHandlers(
  app: FastifyInstance,
  options: ShutdownOptions = {},
): () => void {
  const signals = options.signals ?? DEFAULT_SIGNALS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const proc = options.process ?? process;
  const log = options.log ?? ((message: string) => console.error(message));

  let shuttingDown = false;

  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;

    log(`received ${signal}, shutting down`);

    // Ref'd on purpose: while the close is in flight this timer keeps the loop alive for
    // the grace period, and if the close never settles it is what fires the non-zero
    // exit. A close that resolves normally clears it long before it can.
    const timer = setTimeout(() => {
      log(`shutdown did not finish within ${timeoutMs}ms, exiting`);
      proc.exit(1);
    }, timeoutMs);

    app
      .close()
      .then(() => {
        clearTimeout(timer);
        proc.exit(0);
      })
      .catch((error: unknown) => {
        clearTimeout(timer);
        log(`shutdown failed: ${(error as Error).message}`);
        proc.exit(1);
      });
  };

  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of signals) {
    const handler = (): void => shutdown(signal);
    handlers.set(signal, handler);
    proc.on(signal, handler);
  }

  return () => {
    for (const [signal, handler] of handlers) proc.off(signal, handler);
  };
}

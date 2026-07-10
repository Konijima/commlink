import type { FastifyInstance } from 'fastify';

/**
 * How often the server proves to itself that a subscriber is still there.
 *
 * Idle connections are the normal state of a push system — a topic can go hours
 * without a message — and both ends need to notice a silent death. 45s sits under
 * the 60s idle timeout reverse proxies commonly apply, so a quiet stream is kept
 * open rather than cut.
 */
export const KEEPALIVE_INTERVAL_MS = 45_000;

/**
 * Run `tick` every `intervalMs` for as long as `app` is up.
 *
 * The timer is unref'd, so a server whose only remaining work is its own keepalive
 * does not keep the process alive; and it is cleared when the server closes, so a
 * closed app leaves nothing running behind it.
 */
export function everyInterval(
  app: FastifyInstance,
  intervalMs: number,
  tick: () => void,
): void {
  const timer = setInterval(tick, intervalMs);
  timer.unref();

  app.addHook('onClose', async () => {
    clearInterval(timer);
  });
}

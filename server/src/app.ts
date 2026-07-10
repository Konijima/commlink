import Fastify, { type FastifyInstance } from 'fastify';

/**
 * Build the commlink server instance.
 *
 * Kept as a factory so tests can construct an app and drive it with
 * `app.inject(...)` without binding a real socket.
 */
export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: false });

  // Liveness probe: 200 with the process uptime in seconds.
  app.get('/healthz', async () => {
    return { status: 'ok', uptime: process.uptime() };
  });

  return app;
}

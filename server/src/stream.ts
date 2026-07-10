import type { ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import type { Broker } from './broker';
import { TOPIC_RULE, isValidTopic } from './message';

/**
 * Mount `GET /:topic/json`, a newline-delimited JSON stream carrying the same
 * messages `/:topic/ws` pushes — one message per line, written as it is published:
 *
 *     curl -sN http://127.0.0.1:4500/mytopic/json
 *
 * It is the fallback for clients that cannot open a WebSocket. Like the socket, it
 * is live-only, and the response never completes on its own: the client reads until
 * it disconnects.
 */
export function registerStreamRoute(app: FastifyInstance, broker: Broker): void {
  // A streaming response is never idle, so the HTTP server would wait on it forever
  // while shutting down. End the open ones before the server stops accepting.
  const open = new Set<ServerResponse>();

  app.addHook('preClose', async () => {
    for (const response of open) response.end();
  });

  app.get<{ Params: { topic: string } }>('/:topic/json', (request, reply) => {
    const { topic } = request.params;

    if (!isValidTopic(topic)) {
      reply.code(400).send({ error: TOPIC_RULE });
      return;
    }

    // Fastify's reply lifecycle assumes a response that ends. This one does not, so
    // take the socket over and write onto it directly.
    reply.hijack();

    const response = reply.raw;
    response.writeHead(200, {
      'content-type': 'application/x-ndjson',
      'cache-control': 'no-store',
      // Reverse proxies buffer a response body by default, which would hold every
      // line back until the stream ends — that is, until never.
      'x-accel-buffering': 'no',
    });
    response.flushHeaders();
    open.add(response);

    const unsubscribe = broker.subscribe([topic], (message) => {
      if (response.writableEnded) return;
      response.write(`${JSON.stringify(message)}\n`);
    });

    // Fires both when the client disconnects and when a shutdown ends the response.
    response.on('close', () => {
      unsubscribe();
      open.delete(response);
    });
  });
}

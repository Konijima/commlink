import type { ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import type { Broker } from './broker';
import { KEEPALIVE_INTERVAL_MS, everyInterval } from './keepalive';
import { parseTopicList } from './message';

/**
 * Mount `GET /:topics/json`, a newline-delimited JSON stream carrying the same
 * messages `/:topics/ws` pushes — one message per line, written as it is published:
 *
 *     curl -sN http://127.0.0.1:4500/mytopic/json
 *     curl -sN http://127.0.0.1:4500/mytopic,other/json
 *
 * It is the fallback for clients that cannot open a WebSocket, and multiplexes over
 * a comma-separated topic list just as the socket does. Like the socket, it is
 * live-only, and the response never completes on its own: the client reads until it
 * disconnects.
 */
export function registerStreamRoute(
  app: FastifyInstance,
  broker: Broker,
  intervalMs: number = KEEPALIVE_INTERVAL_MS,
): void {
  // A streaming response is never idle, so the HTTP server would wait on it forever
  // while shutting down. End the open ones before the server stops accepting.
  const open = new Set<ServerResponse>();

  app.addHook('preClose', async () => {
    for (const response of open) response.end();
  });

  // Plain HTTP has no ping frame, so the keepalive is a blank line. NDJSON readers
  // skip it, an intermediary counts it as traffic and holds the connection open, and
  // writing it is what surfaces a peer that vanished without a FIN: the response
  // errors, which detaches the subscriber below.
  everyInterval(app, intervalMs, () => {
    for (const response of open) {
      if (response.writableEnded) continue;
      response.write('\n');
    }
  });

  app.get<{ Params: { topic: string } }>('/:topic/json', (request, reply) => {
    let topics: string[];
    try {
      topics = parseTopicList(request.params.topic);
    } catch (error) {
      reply.code(400).send({ error: (error as Error).message });
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

    const unsubscribe = broker.subscribe(topics, (message) => {
      if (response.writableEnded) return;
      response.write(`${JSON.stringify(message)}\n`);
    });

    const detach = () => {
      unsubscribe();
      open.delete(response);
    };

    // 'close' fires when the client disconnects and when a shutdown ends the response.
    // 'error' fires when a write finds the connection gone — and a response stream with
    // no error listener throws.
    response.on('close', detach);
    response.on('error', detach);
  });
}

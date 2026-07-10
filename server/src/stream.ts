import type { ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { MAX_BUFFERED_BYTES } from './backpressure.js';
import type { Broker } from './broker.js';
import { KEEPALIVE_INTERVAL_MS, everyInterval } from './keepalive.js';
import type { Message } from './message.js';
import { parseSince, parseTopicList } from './message.js';
import type { MessageStore } from './store.js';

export interface StreamOptions {
  /** How often an idle stream is sent a blank line. Shortened by the keepalive tests. */
  keepaliveIntervalMs?: number;
  /** How much may queue for one reader. Lowered by the backpressure tests. */
  maxBufferedBytes?: number;
}

/**
 * Mount `GET /:topics/json`, a newline-delimited JSON stream carrying the same
 * messages `/:topics/ws` pushes — one message per line, written as it is published:
 *
 *     curl -sN http://127.0.0.1:4500/mytopic/json
 *     curl -sN http://127.0.0.1:4500/mytopic,other/json
 *
 * It is the fallback for clients that cannot open a WebSocket, and multiplexes over
 * a comma-separated topic list just as the socket does. It honours `?since=<unix_ts>`
 * exactly as the socket does, replaying the stored backlog before the live messages.
 * The response never completes on its own: the client reads until it disconnects.
 */
export function registerStreamRoute(
  app: FastifyInstance,
  broker: Broker,
  store: MessageStore,
  options: StreamOptions = {},
): void {
  const intervalMs = options.keepaliveIntervalMs ?? KEEPALIVE_INTERVAL_MS;
  const maxBufferedBytes = options.maxBufferedBytes ?? MAX_BUFFERED_BYTES;

  // A streaming response is never idle, so the HTTP server would wait on it forever
  // while shutting down. End the open ones before the server stops accepting.
  const open = new Set<ServerResponse>();

  app.addHook('preClose', async () => {
    for (const response of open) response.end();
  });

  /** Whether `response` can still be written to at all. */
  const isWritable = (response: ServerResponse): boolean =>
    !response.writableEnded && !response.destroyed;

  /**
   * Hang up on a reader whose backlog has passed the limit, and say whether it was.
   * `writableLength` counts what this process is holding for it: bytes written but
   * not yet accepted by the socket. A reader keeping up drains to zero between
   * messages, so only a stalled one ever accumulates.
   *
   * A stream has no close frame to send, and the reader is not reading anyway, so
   * the response is destroyed outright. That frees the backlog and fires `close`,
   * which detaches the subscriber.
   */
  const dropIfBackedUp = (response: ServerResponse): boolean => {
    if (response.writableLength <= maxBufferedBytes) return false;
    response.destroy();
    return true;
  };

  // Plain HTTP has no ping frame, so the keepalive is a blank line. NDJSON readers
  // skip it, an intermediary counts it as traffic and holds the connection open, and
  // writing it is what surfaces a peer that vanished without a FIN: the response
  // errors, which detaches the subscriber below.
  everyInterval(app, intervalMs, () => {
    for (const response of open) {
      if (!isWritable(response)) continue;
      // A stream has no pong to withhold, so a reader that stalled and then went
      // quiet would hold its backlog until the next message. This is where it goes.
      if (dropIfBackedUp(response)) continue;
      response.write('\n');
    }
  });

  app.get<{ Params: { topic: string }; Querystring: { since?: string } }>(
    '/:topic/json',
    (request, reply) => {
      let topics: string[];
      let since: number | null;
      try {
        topics = parseTopicList(request.params.topic);
        since = parseSince(request.query.since);
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

      const send = (message: Message) => {
        if (!isWritable(response)) return;
        if (dropIfBackedUp(response)) return;
        response.write(`${JSON.stringify(message)}\n`);
      };

      const unsubscribe = broker.subscribe(topics, send);

      const detach = () => {
        unsubscribe();
        open.delete(response);
      };

      // 'close' fires when the client disconnects and when a shutdown ends the response.
      // 'error' fires when a write finds the connection gone — and a response stream with
      // no error listener throws.
      response.on('close', detach);
      response.on('error', detach);

      // Read the backlog only once the live listener is attached, so a message published
      // in between is delivered rather than dropped into the gap between the two. See
      // the same ordering, and the duplicate it can produce, in `subscribe.ts`.
      if (since !== null) {
        for (const message of store.since(topics, since)) send(message);
      }
    },
  );
}

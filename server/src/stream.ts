import type { ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { ACCEPTS_QUERY_TOKEN } from './auth.js';
import { MAX_BUFFERED_BYTES } from './backpressure.js';
import type { Broker } from './broker.js';
import { KEEPALIVE_INTERVAL_MS, everyInterval } from './keepalive.js';
import type { Message } from './message.js';
import { parseSince, parseTopicList } from './message.js';
import type { MessageStore } from './store.js';
import type { TokenStore } from './tokens.js';

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
 *
 * A stream is authenticated once, at the request. The same sweep that writes the
 * keepalive line re-checks each reader's token against `tokens`, so a reader whose
 * token was revoked has its response ended within a keepalive interval rather than
 * streaming on until it happens to reconnect.
 */
export function registerStreamRoute(
  app: FastifyInstance,
  broker: Broker,
  store: MessageStore,
  tokens: TokenStore,
  options: StreamOptions = {},
): void {
  const intervalMs = options.keepaliveIntervalMs ?? KEEPALIVE_INTERVAL_MS;
  const maxBufferedBytes = options.maxBufferedBytes ?? MAX_BUFFERED_BYTES;

  // The headers the stream answers with, shared with the `HEAD` below so the two cannot
  // drift: a `HEAD` is a `GET` without the content, and these are the content's terms.
  const STREAM_HEADERS = {
    'content-type': 'application/x-ndjson',
    'cache-control': 'no-store',
    // Reverse proxies buffer a response body by default, which would hold every
    // line back until the stream ends — that is, until never.
    'x-accel-buffering': 'no',
  };

  // Every open response, against the token id that authorized it — so the sweep can end
  // one whose token has been revoked. A streaming response is also never idle, so the
  // HTTP server would wait on it forever while shutting down; the same set is what the
  // preClose hook ends before the server stops accepting.
  const open = new Map<ServerResponse, number>();

  app.addHook('preClose', async () => {
    for (const response of open.keys()) response.end();
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
    for (const [response, tokenId] of open) {
      if (!isWritable(response)) continue;
      if (!tokens.has(tokenId)) {
        // The token that authorized this stream has been revoked. A stream has no close
        // frame to carry a reason, so end the response; the client's read loop stops,
        // and `close` detaches the subscriber.
        response.end();
        continue;
      }
      // A stream has no pong to withhold, so a reader that stalled and then went
      // quiet would hold its backlog until the next message. This is where it goes.
      if (dropIfBackedUp(response)) continue;
      response.write('\n');
    }
  });

  // Answer `HEAD` ourselves. Fastify exposes a `HEAD` for every `GET` by default, running
  // the same handler — and this handler hijacks the socket to write a response that never
  // ends, which is right for a stream and ruinous for a `HEAD`. Node sends no body for one,
  // so every line the stream wrote would be discarded, the backlog could never grow, and
  // the sweep that drops a stalled reader would have nothing to weigh: the subscriber would
  // sit on the broker for as long as the connection lived. Worse, the response never
  // completed, and Node writes responses on a connection in order — so every request behind
  // it on a pooled or keep-alive connection waited forever.
  //
  // A `HEAD` asks what a `GET` would answer with, so answer exactly that: the stream's
  // headers, refused for the same topics, and then — the one thing the stream itself never
  // does — end. Nothing is subscribed, because nothing can be delivered.
  app.head<{ Params: { topic: string }; Querystring: { since?: string } }>(
    '/:topic/json',
    { config: ACCEPTS_QUERY_TOKEN },
    (request, reply) => {
      try {
        parseTopicList(request.params.topic);
        parseSince(request.query.since);
      } catch (error) {
        // The reason rides on `error` for a `GET`. A `HEAD` has no body to carry it, so
        // the status is what a client gets; Fastify sizes the headers for the body it
        // would have sent, and Node withholds the body itself.
        reply.code(400).send({ error: (error as Error).message });
        return;
      }

      reply.hijack();

      const response = reply.raw;
      // Not `reply.send()`: that would declare `content-length: 0`, which claims a `GET`
      // here answers with an empty body. It answers with an unbounded one.
      response.writeHead(200, STREAM_HEADERS);
      response.end();
    },
  );

  app.route<{ Params: { topic: string }; Querystring: { since?: string } }>({
    method: 'GET',
    url: '/:topic/json',
    // A browser cannot set a header on the request it opens a stream with, so this route
    // takes the token in the query string too. The marker is declared here, beside the
    // path, so it cannot be left behind if the path ever moves.
    config: ACCEPTS_QUERY_TOKEN,
    // Do not clone this handler onto `HEAD`: the one above is this route's, written for
    // a request that carries no body. Declaring it first is enough for Fastify to leave
    // the pair alone, but saying so here does not depend on the order the two are read in.
    exposeHeadRoute: false,
    handler: (request, reply) => {
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
      response.writeHead(200, STREAM_HEADERS);
      response.flushHeaders();
      // Auth refuses any stream without a token before this handler runs, so every
      // reader here carries one; the sweep re-checks that id to catch a revocation.
      open.set(response, request.tokenId as number);

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
  });
}

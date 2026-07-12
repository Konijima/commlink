import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { ACCEPTS_QUERY_TOKEN } from './auth.js';
import { MAX_BUFFERED_BYTES } from './backpressure.js';
import type { Broker } from './broker.js';
import { KEEPALIVE_INTERVAL_MS, everyInterval } from './keepalive.js';
import type { Message } from './message.js';
import { parseSince, parseTopicList } from './message.js';
import type { MessageStore } from './store.js';
import type { TokenStore } from './tokens.js';

/**
 * RFC 6455 close code for a message that violates the endpoint's policy. Sent when
 * the requested topics are not ones the server will ever serve.
 */
const CLOSE_POLICY_VIOLATION = 1008;

export interface SubscribeOptions {
  /** How often an idle subscriber is pinged. Shortened by the keepalive tests. */
  keepaliveIntervalMs?: number;
  /** How much may queue for one subscriber. Lowered by the backpressure tests. */
  maxBufferedBytes?: number;
}

/**
 * Mount `GET /:topics/ws`, which upgrades to a WebSocket and pushes every message
 * published to any of `topics` as one JSON frame per message.
 *
 * `topics` is one name or several separated by commas, so a client watching many
 * topics needs only one connection. Each frame names its own topic, which is how a
 * multiplexed subscriber tells them apart.
 *
 * A subscriber sees what is published while its socket is open. `?since=<unix_ts>`
 * additionally replays the stored backlog from that second onwards, so a client whose
 * connection dropped reconnects with `?since=` set to the last timestamp it saw and
 * misses nothing in between.
 *
 * A connection is authenticated once, at the upgrade. The same sweep that pings idle
 * sockets re-checks each one's token against `tokens`, so a subscriber whose token was
 * revoked is closed within a keepalive interval rather than holding its stream until it
 * happens to reconnect.
 */
export function registerSubscribeRoute(
  app: FastifyInstance,
  broker: Broker,
  store: MessageStore,
  tokens: TokenStore,
  options: SubscribeOptions = {},
): void {
  const intervalMs = options.keepaliveIntervalMs ?? KEEPALIVE_INTERVAL_MS;
  const maxBufferedBytes = options.maxBufferedBytes ?? MAX_BUFFERED_BYTES;

  // Every open socket, against whether it has been heard from since the last ping.
  const responded = new Map<WebSocket, boolean>();

  // The token id that authorized each socket, so the sweep can tell when it was revoked.
  const tokenOf = new Map<WebSocket, number>();

  everyInterval(app, intervalMs, () => {
    for (const [socket, heardFrom] of responded) {
      if (socket.readyState !== socket.OPEN) continue;

      const tokenId = tokenOf.get(socket);
      if (tokenId === undefined || !tokens.has(tokenId)) {
        // The token that authorized this subscription has been revoked. Close with the
        // policy code and a reason, so the client learns why rather than seeing a bare
        // drop, and let `close` detach it from the broker.
        socket.close(CLOSE_POLICY_VIOLATION, 'token revoked');
        continue;
      }

      if (!heardFrom) {
        // A whole interval with no pong. The peer is gone or wedged, and a TCP write
        // to a half-open connection can sit unanswered for far longer than we want to
        // hold a subscriber's memory. `terminate` fires `close`, which detaches it.
        socket.terminate();
        continue;
      }

      responded.set(socket, false);
      socket.ping();
    }
  });

  app.route<{ Params: { topic: string }; Querystring: { since?: string } }>({
    method: 'GET',
    url: '/:topic/ws',
    // A browser cannot set a header on a WebSocket handshake, so this route takes the
    // token in the query string too. The marker is declared here, beside the path, so it
    // cannot be left behind if the path ever moves.
    config: ACCEPTS_QUERY_TOKEN,
    // A GET that never upgraded — a browser opening the URL, or a reverse proxy that
    // dropped the `Upgrade` header (see deploy/README.md). The route matched, so the
    // not-found handler never runs, and `@fastify/websocket` would otherwise answer a
    // bare, bodyless 404. Reply in the `{ error }` shape every other refusal uses, so a
    // client can still read the reason off `error` however it reached here.
    handler: (_request, reply) => {
      reply.code(404).send({ error: 'not found' });
    },
    wsHandler: (socket: WebSocket, request) => {
      let topics: string[];
      let since: number | null;
      try {
        topics = parseTopicList(request.params.topic);
        since = parseSince(request.query.since);
      } catch (error) {
        // The upgrade has already completed, so a bad request is reported as a close
        // frame rather than a 400. Clients read the reason off the close event. `ws`
        // throws on a reason over 123 bytes; every rule here is well under it.
        socket.close(CLOSE_POLICY_VIOLATION, (error as Error).message);
        return;
      }

      const send = (message: Message) => {
        // A socket that is closing still accepts `send`, which then queues forever.
        if (socket.readyState !== socket.OPEN) return;

        if (socket.bufferedAmount > maxBufferedBytes) {
          // The peer has stopped reading and its backlog is ours to hold. A close
          // frame would only queue behind that same backlog, so there is no polite
          // way out: drop the connection and let the client come back.
          socket.terminate();
          return;
        }

        socket.send(JSON.stringify(message));
      };

      const unsubscribe = broker.subscribe(topics, send);

      responded.set(socket, true);
      // Auth refuses any subscribe without a token before this handler runs, so every
      // socket here carries one; the sweep re-checks that id to catch a revocation.
      tokenOf.set(socket, request.tokenId as number);
      // `ws` answers a ping with a pong on its own, so a healthy client needs no code
      // of its own to stay subscribed.
      socket.on('pong', () => responded.set(socket, true));

      const detach = () => {
        responded.delete(socket);
        tokenOf.delete(socket);
        unsubscribe();
      };

      socket.on('close', detach);

      // `ws` throws on an 'error' event with no listener. A socket that errors also
      // closes, so the unsubscribe above is what actually detaches the listener.
      socket.on('error', detach);

      // Read the backlog only once the live listener is attached, so a message
      // published in between is delivered rather than dropped into the gap between
      // the two. It can then arrive twice — once from the store, once live — which is
      // the same duplicate an inclusive `since` bound already produces, and which
      // clients resolve by de-duplicating on `id`.
      if (since !== null) {
        for (const message of store.since(topics, since)) send(message);
      }
    },
  });
}

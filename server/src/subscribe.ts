import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { MAX_BUFFERED_BYTES } from './backpressure';
import type { Broker } from './broker';
import { KEEPALIVE_INTERVAL_MS, everyInterval } from './keepalive';
import { parseTopicList } from './message';

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
 * Subscribers are live-only: a frame arrives for messages published while the socket
 * is open, and nothing is replayed on connect. Caching and `?since=` come later.
 */
export function registerSubscribeRoute(
  app: FastifyInstance,
  broker: Broker,
  options: SubscribeOptions = {},
): void {
  const intervalMs = options.keepaliveIntervalMs ?? KEEPALIVE_INTERVAL_MS;
  const maxBufferedBytes = options.maxBufferedBytes ?? MAX_BUFFERED_BYTES;

  // Every open socket, against whether it has been heard from since the last ping.
  const responded = new Map<WebSocket, boolean>();

  everyInterval(app, intervalMs, () => {
    for (const [socket, heardFrom] of responded) {
      if (socket.readyState !== socket.OPEN) continue;

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

  app.get<{ Params: { topic: string } }>(
    '/:topic/ws',
    { websocket: true },
    (socket: WebSocket, request) => {
      let topics: string[];
      try {
        topics = parseTopicList(request.params.topic);
      } catch (error) {
        // The upgrade has already completed, so a bad topic list is reported as a
        // close frame rather than a 400. Clients read the reason off the close event.
        // `ws` throws on a reason over 123 bytes; both topic rules are well under it.
        socket.close(CLOSE_POLICY_VIOLATION, (error as Error).message);
        return;
      }

      const unsubscribe = broker.subscribe(topics, (message) => {
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
      });

      responded.set(socket, true);
      // `ws` answers a ping with a pong on its own, so a healthy client needs no code
      // of its own to stay subscribed.
      socket.on('pong', () => responded.set(socket, true));

      const detach = () => {
        responded.delete(socket);
        unsubscribe();
      };

      socket.on('close', detach);

      // `ws` throws on an 'error' event with no listener. A socket that errors also
      // closes, so the unsubscribe above is what actually detaches the listener.
      socket.on('error', detach);
    },
  );
}

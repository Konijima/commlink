import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { Broker } from './broker';
import { isValidTopic } from './message';

/**
 * RFC 6455 close code for a message that violates the endpoint's policy. Sent when
 * the requested topic name is not one the server will ever serve.
 */
const CLOSE_POLICY_VIOLATION = 1008;

/**
 * Mount `GET /:topic/ws`, which upgrades to a WebSocket and pushes every message
 * published to `topic` as one JSON frame per message.
 *
 * Subscribers are live-only: a frame arrives for messages published while the socket
 * is open, and nothing is replayed on connect. Caching and `?since=` come later.
 */
export function registerSubscribeRoute(app: FastifyInstance, broker: Broker): void {
  app.get<{ Params: { topic: string } }>(
    '/:topic/ws',
    { websocket: true },
    (socket: WebSocket, request) => {
      const { topic } = request.params;

      // The upgrade has already completed, so a bad topic is reported as a close
      // frame rather than a 400. Clients read the reason off the close event.
      if (!isValidTopic(topic)) {
        socket.close(CLOSE_POLICY_VIOLATION, 'invalid topic');
        return;
      }

      const unsubscribe = broker.subscribe([topic], (message) => {
        // A socket that is closing still accepts `send`, which then queues forever.
        if (socket.readyState !== socket.OPEN) return;
        socket.send(JSON.stringify(message));
      });

      socket.on('close', unsubscribe);

      // `ws` throws on an 'error' event with no listener. A socket that errors also
      // closes, so the unsubscribe above is what actually detaches the listener.
      socket.on('error', unsubscribe);
    },
  );
}

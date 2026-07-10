import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerAuth } from './auth.js';
import { Broker } from './broker.js';
import {
  MAX_TOPIC_LIST_LENGTH,
  TOPIC_RULE,
  createMessage,
  headerValue,
  isValidTopic,
  parsePriority,
  parseTags,
  parseTitle,
} from './message.js';
import { RateLimiter, publishRateLimit } from './ratelimit.js';
import { registerRetention } from './retention.js';
import { MessageStore } from './store.js';
import { registerStreamRoute } from './stream.js';
import { registerSubscribeRoute } from './subscribe.js';
import { TokenStore } from './tokens.js';

export interface AppOptions {
  /** Injectable so tests can watch the fan-out the routes share. */
  broker?: Broker;
  /**
   * Where published messages are persisted. Defaults to a throwaway in-memory store,
   * so a caller that wants messages to outlive the process passes one built on a file
   * — as `server.ts` does. A store passed in is the caller's to close; one created
   * here is closed with the app.
   */
  store?: MessageStore;
  /**
   * The tokens that authorize publishing and subscribing. Defaults to a throwaway
   * in-memory store, which holds none, so an app built without one authorizes nothing.
   * Ownership follows `store`: a store passed in is the caller's to close.
   */
  tokens?: TokenStore;
  /** How often subscriber connections are pinged. Shortened by the keepalive tests. */
  keepaliveIntervalMs?: number;
  /** How long a message stays replayable, in hours. Defaults to 72. */
  retentionHours?: number;
  /** How often expired messages are swept. Shortened by the retention tests. */
  retentionSweepIntervalMs?: number;
  /**
   * How many bytes may queue for one subscriber before it is dropped. Lowered by the
   * backpressure tests, which cannot stall a real socket by a megabyte quickly.
   */
  maxBufferedBytes?: number;
  /**
   * How many publishes one token may make per minute. Defaults to 60. Lowered by the
   * rate-limit tests, which would otherwise have to publish 60 times to reach the cap.
   */
  publishRateLimit?: number;
}

/**
 * Build the commlink server instance.
 *
 * Kept as a factory so tests can construct an app and drive it with
 * `app.inject(...)` without binding a real socket.
 */
export function buildApp(options: AppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: false,
    // A multiplexed subscribe names all of its topics in one path segment, which
    // overruns the router's 100-character default and is answered with `414` before
    // the route runs. Admit any list the subscribe routes would accept, and let them
    // be the ones to reject what is too long.
    routerOptions: { maxParamLength: MAX_TOPIC_LIST_LENGTH },
  });
  const broker = options.broker ?? new Broker();

  const store = options.store ?? new MessageStore();
  if (options.store === undefined) {
    app.addHook('onClose', async () => store.close());
  }

  const tokens = options.tokens ?? new TokenStore();
  if (options.tokens === undefined) {
    app.addHook('onClose', async () => tokens.close());
  }

  // Before any route handler: a request that cannot authenticate reaches neither a
  // topic parser nor a WebSocket upgrade.
  registerAuth(app, tokens);

  registerRetention(app, store, {
    retentionHours: options.retentionHours,
    sweepIntervalMs: options.retentionSweepIntervalMs,
  });

  const subscriberOptions = {
    keepaliveIntervalMs: options.keepaliveIntervalMs,
    maxBufferedBytes: options.maxBufferedBytes,
  };

  // A message body is opaque text, whatever the sender labels it. Replacing the
  // built-in parsers keeps `curl -d hello` (which sends x-www-form-urlencoded)
  // from being rejected as an unsupported media type, and stops a JSON body from
  // being reshaped into an object on its way to subscribers.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'string' }, (_request, body, done) => {
    done(null, body);
  });

  // Liveness probe: 200 with the process uptime in seconds.
  app.get('/healthz', async () => {
    return { status: 'ok', uptime: process.uptime() };
  });

  // Publish to a topic. The body is the message text; `X-Title`, `X-Priority`
  // and `X-Tags` carry the metadata. Every attempt costs the publishing token one of
  // its slots, including one the handler goes on to reject: a client hammering the
  // server with malformed publishes is the case the limit is for.
  const limiter = new RateLimiter(options.publishRateLimit);

  app.post<{ Params: { topic: string } }>(
    '/:topic',
    { preHandler: publishRateLimit(limiter) },
    async (request, reply) => {
      const { topic } = request.params;

      if (!isValidTopic(topic)) {
        return reply.code(400).send({ error: TOPIC_RULE });
      }

      let priority: number;
      try {
        priority = parsePriority(headerValue(request.headers['x-priority']));
      } catch (error) {
        return reply.code(400).send({ error: (error as Error).message });
      }

      const title = parseTitle(headerValue(request.headers['x-title']));
      const text = typeof request.body === 'string' ? request.body : '';

      // A notification with neither body nor title would show up blank.
      if (text.length === 0 && title === null) {
        return reply.code(400).send({ error: 'message body or X-Title is required' });
      }

      const message = createMessage({
        topic,
        message: text,
        title,
        priority,
        tags: parseTags(headerValue(request.headers['x-tags'])),
      });

      // Store before fanning out. A message a live subscriber has already seen must
      // also be one a reconnecting subscriber can replay, and a write that fails should
      // fail the publish rather than deliver a message that was never recorded.
      store.append(message);
      broker.publish(message);

      return reply.code(200).send(message);
    },
  );

  registerStreamRoute(app, broker, store, subscriberOptions);

  // The subscribe route lives inside a plugin scope so that it is registered after
  // `@fastify/websocket` has loaded and can claim it as an upgrade route.
  app.register(fastifyWebsocket);
  app.register(async (scope) => {
    registerSubscribeRoute(scope, broker, store, subscriberOptions);
  });

  return app;
}

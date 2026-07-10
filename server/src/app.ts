import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { Broker } from './broker';
import {
  createMessage,
  headerValue,
  isValidTopic,
  parsePriority,
  parseTags,
  parseTitle,
} from './message';
import { registerSubscribeRoute } from './subscribe';

export interface AppOptions {
  /** Injectable so tests can watch the fan-out the routes share. */
  broker?: Broker;
}

/**
 * Build the commlink server instance.
 *
 * Kept as a factory so tests can construct an app and drive it with
 * `app.inject(...)` without binding a real socket.
 */
export function buildApp(options: AppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false });
  const broker = options.broker ?? new Broker();

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
  // and `X-Tags` carry the metadata.
  app.post<{ Params: { topic: string } }>('/:topic', async (request, reply) => {
    const { topic } = request.params;

    if (!isValidTopic(topic)) {
      return reply.code(400).send({
        error: 'topic must be 1-64 characters of A-Z, a-z, 0-9, hyphen or underscore',
      });
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

    broker.publish(message);

    return reply.code(200).send(message);
  });

  // The subscribe route lives inside a plugin scope so that it is registered after
  // `@fastify/websocket` has loaded and can claim it as an upgrade route.
  app.register(fastifyWebsocket);
  app.register(async (scope) => {
    registerSubscribeRoute(scope, broker);
  });

  return app;
}

import fastifyWebsocket from '@fastify/websocket';
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';
import { registerAuth } from './auth.js';
import { Broker } from './broker.js';
import { DEFAULT_DB_PATH } from './dbpath.js';
import {
  BODY_ENCODING_RULE,
  EMPTY_MESSAGE_RULE,
  MALFORMED_URL_RULE,
  MAX_BODY_BYTES,
  MAX_TOPIC_LIST_LENGTH,
  TOPIC_LIST_TOO_LONG_RULE,
  TOPIC_RULE,
  bodyRule,
  createMessage,
  decodeBody,
  headerValue,
  parsePriority,
  parseTags,
  parseTitle,
  topicRefusal,
} from './message.js';
import { RateLimiter, publishRateLimit } from './ratelimit.js';
import { registerRetention } from './retention.js';
import { MessageStore } from './store.js';
import { registerStreamRoute } from './stream.js';
import { registerSubscribeRoute } from './subscribe.js';
import { TokenStore } from './tokens.js';

/**
 * The Fastify error code the content-type parser tags a non-UTF-8 body with, so the
 * error handler can answer it in the same `{ error }` shape as an over-long one rather
 * than letting Fastify's default 500 shape through.
 */
const BODY_ENCODING_CODE = 'COMMLINK_ERR_BODY_ENCODING';

/**
 * What the server logs at startup when its token store holds no tokens. A store with none
 * authorizes nobody — `/healthz` answers, every publish and subscribe is refused with a
 * `401` — which is the safe way to boot but looks, from the outside, exactly like a broken
 * server. An operator who has not yet minted a token sees only 401s with no hint why; this
 * names the cause and the fix in the same structured log everything else rides, so the
 * reason is one line away rather than a debugging session.
 *
 * The fix has to work where the operator will run it, which is why the warning names the
 * database rather than the bare command. A server started by a service manager takes its
 * `DB_PATH` from the unit, where `Environment=DB_PATH=…` exists in the *service's*
 * environment and nowhere else; the token commands resolve `DB_PATH` from their own — a
 * `.env` in their working directory, then the variable itself — and fall back to
 * {@link DEFAULT_DB_PATH}. So a bare `pnpm token:create` run from the operator's shell
 * mints into the checkout while the server goes on refusing every request: a server that
 * authorizes nobody, holding a token that works nowhere, which is the outcome the blank and
 * `:memory:` `DB_PATH` refusals already exist to prevent. Setting `DB_PATH` inline is right
 * wherever the command is run.
 *
 * `dbPath` is the store's own {@link TokenStore.path}, so the warning cannot name a database
 * other than the one that was found empty — and on any server an operator runs it is a real
 * file, since a whole-server `:memory:` is refused at boot (`parseDbPath`).
 */
export function noTokensWarning(dbPath: string): string {
  return (
    `no tokens exist in ${dbPath}: every publish and subscribe will be refused with 401 until ` +
    `one is minted against that database — \`DB_PATH=${dbPath} pnpm token:create <name>\`. Name ` +
    `the path: the token command reads DB_PATH from its own environment, and a service unit's ` +
    `Environment=DB_PATH lives only in the service's, so a bare \`pnpm token:create\` mints into ` +
    `${DEFAULT_DB_PATH}, which this server never reads.`
  );
}

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
  /**
   * The largest publish body accepted, in bytes. Defaults to {@link MAX_BODY_BYTES}.
   * Raised by the backpressure tests, which stall a subscriber by filling the socket
   * underneath it and would need hundreds of messages to do that 4 KB at a time.
   */
  maxBodyBytes?: number;
  /**
   * The pino logger configuration, as {@link https://fastify.dev/docs/latest/Reference/Logging/ Fastify}
   * takes it. Defaults to `false` — off — so the test suite stays quiet and `app.inject`
   * output is not drowned in request lines. The entrypoint passes a real configuration
   * built from `LOG_LEVEL`; the logging test passes one with a capturing stream.
   */
  logger?: FastifyServerOptions['logger'];
}

/**
 * Build the commlink server instance.
 *
 * Kept as a factory so tests can construct an app and drive it with
 * `app.inject(...)` without binding a real socket.
 */
export function buildApp(options: AppOptions = {}): FastifyInstance {
  const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;

  const app = Fastify({
    logger: options.logger ?? false,
    // A body over the limit is refused while it is being read, which is earlier than
    // any hook of ours can run — earlier, in particular, than the one that
    // authenticates. That ordering is the point: an anonymous client cannot make the
    // server hold a megabyte for it just by opening a request.
    bodyLimit: maxBodyBytes,
    // A multiplexed subscribe names all of its topics in one path segment, which
    // overruns the router's 100-character default and is answered with `414` before
    // the route runs. Admit any list the subscribe routes would accept, and let them
    // be the ones to reject what is too long.
    routerOptions: { maxParamLength: MAX_TOPIC_LIST_LENGTH },
    // The router refuses two kinds of request before any route — and so before the
    // error and not-found handlers below — runs: a topic segment past `maxParamLength`
    // (`414`) and a path that is not a valid URL (`400`). Fastify answers both with its
    // default `{ error, code, message }` body, the one shape a client cannot read a
    // plain reason off `error` from. Rewrite them into the `{ error }` shape every other
    // refusal uses. The `maxParamLength` cap is sized for the longest legal subscribe
    // list, so it governs the publish `:topic` segment too: a `414` on a `POST` is a
    // single over-long topic and hears the one-topic rule, while one on a subscribe `GET`
    // could be either too many topics or one name too long and names both bounds. Written
    // to the raw response, the way Fastify's own default framework-error path is.
    frameworkErrors: (error, request, reply) => {
      const [statusCode, message] =
        error.code === 'FST_ERR_MAX_PARAM_LENGTH'
          ? ([
              414,
              request.method === 'POST' ? TOPIC_RULE : TOPIC_LIST_TOO_LONG_RULE,
            ] as const)
          : error.code === 'FST_ERR_BAD_URL'
            ? ([400, MALFORMED_URL_RULE] as const)
            : ([error.statusCode ?? 500, error.message] as const);
      const body = JSON.stringify({ error: message });
      reply.raw.writeHead(statusCode, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
      });
      reply.raw.end(body);
    },
  });

  // Report a body the transport refused in the shape every other refusal uses: an
  // over-long one (413) and one that is not UTF-8 (400) are both rejected while the body
  // is read, before any handler runs. Everything else is handed back to Fastify, whose
  // default handler this one replaces.
  app.setErrorHandler<FastifyError>((error, _request, reply) => {
    if (error.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return reply.code(413).send({ error: bodyRule(maxBodyBytes) });
    }
    if (error.code === BODY_ENCODING_CODE) {
      return reply.code(400).send({ error: BODY_ENCODING_RULE });
    }
    return reply.send(error);
  });

  // Answer an unknown path or an unsupported method in the same `{ error }` shape every
  // deliberate refusal uses, rather than Fastify's default `{ message, error, statusCode }`
  // — so a client that reads the reason off `error` finds it wherever it looks. This runs
  // after the auth hook, so an unauthenticated request still hears `401` before it learns
  // whether the route exists; only an authenticated wrong turn reaches here.
  app.setNotFoundHandler((_request, reply) => {
    return reply.code(404).send({ error: 'not found' });
  });

  const broker = options.broker ?? new Broker();

  // A subscriber's delivery closure — a WebSocket `send` or a stream `write` — can throw,
  // and the broker deliberately swallows it so one broken socket cannot silence a topic for
  // the others. Left unwired that failure is invisible, the one hole in a server that
  // otherwise logs everything. Route it to the structured log so an operator can see a
  // delivery that failed rather than a message that quietly reached fewer subscribers than
  // it should have. This owns the hook on whatever broker the app runs, injected or not.
  broker.onListenerError = (error, message) => {
    app.log.error(
      { err: error, topic: message.topic, id: message.id },
      'delivering a message to a subscriber failed',
    );
  };

  const store = options.store ?? new MessageStore();
  if (options.store === undefined) {
    app.addHook('onClose', async () => store.close());
  }

  const tokens = options.tokens ?? new TokenStore();
  if (options.tokens === undefined) {
    app.addHook('onClose', async () => tokens.close());
  }

  // Warn once at build time if the store authorizes nobody, naming the database it found
  // empty so the fix it prints mints into that one. This is silent under the default
  // `logger: false`, so the test suite's throwaway in-memory stores stay quiet; the
  // entrypoint's real logger is where an operator running a fresh install sees it.
  if (tokens.count() === 0) {
    app.log.warn(noTokensWarning(tokens.path));
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
  // being reshaped into an object on its way to subscribers. It arrives as the raw
  // bytes the client sent and is decoded as UTF-8, so a body that is not UTF-8 is
  // refused here — while it is read, before any handler — rather than silently
  // delivered as U+FFFD replacements, the same rule `X-Title` keeps.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => {
    try {
      done(null, decodeBody(body as Buffer));
    } catch {
      const error = new Error(BODY_ENCODING_RULE) as FastifyError;
      error.code = BODY_ENCODING_CODE;
      error.statusCode = 400;
      done(error);
    }
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

      const refusal = topicRefusal(topic);
      if (refusal !== null) {
        return reply.code(400).send({ error: refusal });
      }

      // Each of these reports an unusable header by naming the rule it broke. The body
      // is bounded by `bodyLimit` above, which answers 413 before this handler runs;
      // these are the metadata alongside it, and a client that got one wrong hears
      // which one rather than a bare refusal.
      let priority: number;
      let title: string | null;
      let tags: string[];
      try {
        priority = parsePriority(headerValue(request.headers['x-priority']));
        title = parseTitle(headerValue(request.headers['x-title']));
        tags = parseTags(headerValue(request.headers['x-tags']));
      } catch (error) {
        return reply.code(400).send({ error: (error as Error).message });
      }

      const text = typeof request.body === 'string' ? request.body : '';

      // A notification with neither body nor title would show up blank. A body that is
      // only whitespace renders just as blank as an empty one, so it counts as no body
      // here — the same way `parseTitle` already treats a whitespace-only `X-Title` as
      // no title. The stored body is left verbatim: only this emptiness test ignores
      // whitespace, so a message with real content keeps whatever spacing it was sent.
      if (text.trim().length === 0 && title === null) {
        return reply.code(400).send({ error: EMPTY_MESSAGE_RULE });
      }

      const message = createMessage({
        topic,
        message: text,
        title,
        priority,
        tags,
      });

      // Store before fanning out. A message a live subscriber has already seen must
      // also be one a reconnecting subscriber can replay, and a write that fails should
      // fail the publish rather than deliver a message that was never recorded.
      store.append(message);
      broker.publish(message);

      return reply.code(200).send(message);
    },
  );

  registerStreamRoute(app, broker, store, tokens, subscriberOptions);

  // The subscribe route lives inside a plugin scope so that it is registered after
  // `@fastify/websocket` has loaded and can claim it as an upgrade route.
  app.register(fastifyWebsocket);
  app.register(async (scope) => {
    registerSubscribeRoute(scope, broker, store, tokens, subscriberOptions);
  });

  return app;
}

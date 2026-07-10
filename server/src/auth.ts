import type { FastifyInstance, FastifyRequest } from 'fastify';
import { headerValue } from './message.js';
import type { TokenStore } from './tokens.js';

/**
 * Routes served without a token. A liveness probe runs where a secret should not have
 * to: a service manager, a uptime checker, a container orchestrator.
 */
const PUBLIC_ROUTES = new Set(['/healthz']);

/** What the server tells a client that presented no token, or the wrong one. */
export const AUTH_RULE = 'a valid bearer token is required';

/** The challenge sent with every `401`, as `WWW-Authenticate` is required to carry. */
export const AUTH_CHALLENGE = 'Bearer realm="commlink"';

const BEARER_PATTERN = /^Bearer +(\S+)$/i;

/**
 * The token `request` presents, or `null` if it presents none the server can read.
 *
 * `Authorization: Bearer <token>` works everywhere. Subscribe routes additionally take
 * `?auth=<token>`, because a browser cannot set a header on a WebSocket handshake and
 * would otherwise have no way to authenticate at all. Publishing does not take it: a
 * query string is the part of a URL that proxies and access logs write down, and a
 * publisher is a program that can always set a header.
 *
 * Subscribing is exactly the set of `GET` routes that need a token, so that is the
 * test — `/healthz` never reaches here.
 */
export function presentedToken(request: FastifyRequest): string | null {
  const header = headerValue(request.headers.authorization);
  if (header !== undefined) {
    // A malformed `Authorization` is a failed attempt to authenticate, not an absent
    // one: fall through to no token rather than looking for a query parameter the
    // client did not mean to use.
    const match = BEARER_PATTERN.exec(header.trim());
    return match ? match[1] : null;
  }

  if (request.method === 'GET') {
    const auth = headerValue((request.query as { auth?: string | string[] }).auth);
    if (auth !== undefined && auth.length > 0) return auth;
  }

  return null;
}

/**
 * Require a token issued by `tokens` on every route but the health probe.
 *
 * The check runs in `preValidation`, which is the last hook before a route handler and
 * so before a subscribe route performs its upgrade: an unauthorized client is answered
 * with a `401` to the handshake and never holds a WebSocket. An earlier hook would
 * refuse it just as well, but replying from `onRequest` pre-empts the websocket
 * plugin's own hook there, and with it the cleanup that closes the pending upgrade —
 * the refused connection would then sit open until the client gave up.
 *
 * Missing, malformed and simply wrong tokens all hear the same `401`. Which of the
 * three it was is not the server's to tell.
 */
export function registerAuth(app: FastifyInstance, tokens: TokenStore): void {
  app.addHook('preValidation', async (request, reply) => {
    if (PUBLIC_ROUTES.has(request.routeOptions.url ?? '')) return;

    const token = presentedToken(request);
    if (token !== null && tokens.verify(token)) return;

    reply.code(401).header('www-authenticate', AUTH_CHALLENGE).send({ error: AUTH_RULE });
    return reply;
  });
}

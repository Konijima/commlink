import type { FastifyInstance, FastifyRequest } from 'fastify';
import { headerValue } from './message.js';
import type { TokenStore } from './tokens.js';

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Which token authenticated this request, as {@link TokenStore.identify} numbers
     * them. `undefined` on the public routes, which authenticate nobody.
     */
    tokenId: number | undefined;
  }

  interface FastifyContextConfig {
    /** Set by {@link PUBLIC_ROUTE}. Absent on every route that is not marked with it. */
    publicRoute?: true;
    /** Set by {@link ACCEPTS_QUERY_TOKEN}. Absent on every route not marked with it. */
    queryToken?: true;
  }
}

/**
 * Marks a route as served without a token. A liveness probe runs where a secret should
 * not have to: a service manager, an uptime checker, a container orchestrator.
 *
 * Spread into the route's `config`, not listed here by path — see {@link ACCEPTS_QUERY_TOKEN}
 * for why the marker travels with the route rather than in a set beside it.
 */
export const PUBLIC_ROUTE = { publicRoute: true } as const;

/**
 * Marks a route as additionally taking `?auth=<token>`, on top of the `Authorization`
 * header every route takes. Worn by the two subscribe routes, whatever method they are
 * asked with, because a browser cannot set a header on a WebSocket handshake.
 *
 * The marker rides on the route's own `config`, so the auth rule is a *view* of the route
 * table rather than a copy of it: rename a subscribe route, or give it another method, and
 * the credential it accepts follows it, because it is declared in the same breath as the
 * path. A second list of paths kept over here is the thing that goes stale — the rule was
 * once keyed on `GET` as a stand-in for "the subscribe routes", which was true until the
 * stream grew a `HEAD` and could no longer authenticate with the credential its own `GET`
 * accepts on the same URL.
 *
 * It fails closed either way: a route that does not wear the marker simply refuses the
 * query token and answers `401`. It never hands one out.
 */
export const ACCEPTS_QUERY_TOKEN = { queryToken: true } as const;

/** What the server tells a client that presented no token, or the wrong one. */
export const AUTH_RULE = 'a valid bearer token is required';

/** The challenge sent with every `401`, as `WWW-Authenticate` is required to carry. */
export const AUTH_CHALLENGE = 'Bearer realm="commlink"';

const BEARER_PATTERN = /^Bearer +(\S+)$/i;

/**
 * The token `request` presents, or `null` if it presents none the server can read.
 *
 * `Authorization: Bearer <token>` works everywhere. A route marked
 * {@link ACCEPTS_QUERY_TOKEN} additionally takes `?auth=<token>`, because a browser cannot
 * set a header on a WebSocket handshake and would otherwise have no way to authenticate at
 * all. Publishing does not take it: a query string is the part of a URL that proxies and
 * access logs write down, and a publisher is a program that can always set a header.
 *
 * The marker is read off the route the request matched, so a subscribe route accepts the
 * query token whatever method it is asked with — a `HEAD` of the stream reads the same
 * credential its `GET` does, off the same URL. An unmatched path matched no route, so it
 * wears no marker and reads no query token: `?auth=` is a credential of the routes that
 * document it, not of every URL a client can type. `/healthz` never reaches here.
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

  if (request.routeOptions.config?.queryToken) {
    const auth = headerValue((request.query as { auth?: string | string[] }).auth);
    if (auth !== undefined && auth.length > 0) return auth;
  }

  return null;
}

/**
 * Require a token issued by `tokens` on every route but those marked {@link PUBLIC_ROUTE}.
 *
 * A route that matched nothing wears no marker, so it is not public and not a query-token
 * route: an unauthenticated probe of an unknown path hears `401` before it learns whether
 * the route exists.
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
 *
 * A request that gets through carries the id of the token it presented, which is how a
 * later hook charges the request to whoever made it.
 */
export function registerAuth(app: FastifyInstance, tokens: TokenStore): void {
  app.decorateRequest('tokenId', undefined);

  app.addHook('preValidation', async (request, reply) => {
    if (request.routeOptions.config?.publicRoute) return;

    const token = presentedToken(request);
    const tokenId = token === null ? null : tokens.identify(token);
    if (tokenId !== null) {
      request.tokenId = tokenId;
      return;
    }

    reply.code(401).header('www-authenticate', AUTH_CHALLENGE).send({ error: AUTH_RULE });
    return reply;
  });
}

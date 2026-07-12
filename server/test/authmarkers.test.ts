import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ACCEPTS_QUERY_TOKEN,
  AUTH_RULE,
  PUBLIC_ROUTE,
  registerAuth,
} from '../src/auth.js';
import { TokenStore } from '../src/tokens.js';
import { bearer } from './helpers.js';

/**
 * The auth rules are read off the route that answered, not off a list of paths kept
 * beside them. These tests mount routes at paths the server does not serve — so a rule
 * that were keyed on `/:topic/ws` or `/:topic/json`, as it once was, could not satisfy
 * any of them — and assert the credential follows the marker wherever the route is
 * declared. That is the property that keeps the rule from going stale when a route is
 * renamed or grows a method: it is a view of the route table, not a copy of it.
 */
describe('auth rules travel on the route', () => {
  let app: FastifyInstance;
  let tokens: TokenStore;
  let token: string;

  beforeEach(async () => {
    tokens = new TokenStore();
    token = tokens.create('test');

    app = Fastify();
    registerAuth(app, tokens);

    // Deliberately not the real subscribe paths: the point is that nothing is keyed on
    // them. A browser-facing route says so by wearing the marker, and that is all.
    app.get('/elsewhere/socket', { config: ACCEPTS_QUERY_TOKEN }, async () => ({
      ok: true,
    }));
    app.get('/elsewhere/plain', async () => ({ ok: true }));
    app.get('/elsewhere/open', { config: PUBLIC_ROUTE }, async () => ({ ok: true }));

    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    tokens.close();
  });

  describe('a route marked ACCEPTS_QUERY_TOKEN', () => {
    it('authenticates by ?auth=', async () => {
      const res = await app.inject({ url: `/elsewhere/socket?auth=${token}` });

      expect(res.statusCode).toBe(200);
    });

    // A route does not change what it exposes by acquiring a second method, so the
    // marker is not read per-method. Fastify exposes this HEAD from the GET above.
    it('authenticates by ?auth= on a HEAD of it too', async () => {
      const res = await app.inject({
        method: 'HEAD',
        url: `/elsewhere/socket?auth=${token}`,
      });

      expect(res.statusCode).toBe(200);
    });

    it('still authenticates by header', async () => {
      const res = await app.inject({
        url: '/elsewhere/socket',
        headers: bearer(token),
      });

      expect(res.statusCode).toBe(200);
    });

    it('refuses an unissued token in ?auth=', async () => {
      const res = await app.inject({ url: `/elsewhere/socket?auth=${'x'.repeat(43)}` });

      expect(res.statusCode).toBe(401);
      expect((res.json() as { error: string }).error).toBe(AUTH_RULE);
    });
  });

  describe('a route without the marker', () => {
    it('refuses a valid token in ?auth=', async () => {
      const res = await app.inject({ url: `/elsewhere/plain?auth=${token}` });

      expect(res.statusCode).toBe(401);
      expect((res.json() as { error: string }).error).toBe(AUTH_RULE);
    });

    it('still authenticates by header', async () => {
      const res = await app.inject({
        url: '/elsewhere/plain',
        headers: bearer(token),
      });

      expect(res.statusCode).toBe(200);
    });
  });

  describe('a route marked PUBLIC_ROUTE', () => {
    it('is served without a token', async () => {
      expect((await app.inject({ url: '/elsewhere/open' })).statusCode).toBe(200);
    });
  });

  // An unmatched path matched no route, so it wears no marker: it is neither public nor
  // a query-token route, and hears 401 before it learns the route does not exist.
  it('reads no token off an unmatched path', async () => {
    const res = await app.inject({ url: `/no-such-path?auth=${token}` });

    expect(res.statusCode).toBe(401);
    expect((res.json() as { error: string }).error).toBe(AUTH_RULE);
  });
});

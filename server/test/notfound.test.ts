import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { bearer, buildTestApp } from './helpers.js';
import type { TokenStore } from '../src/tokens.js';

/**
 * Every deliberate refusal the server makes answers with `{ error: <reason> }`. An
 * unknown path or an unsupported method must answer the same way, rather than leaking
 * Fastify's default `{ message, error, statusCode }` shape — a client that reads the
 * reason off `error` should find it wherever it looks.
 */
describe('unknown routes', () => {
  let app: FastifyInstance;
  let tokens: TokenStore;

  afterEach(async () => {
    await app.close();
    tokens.close();
  });

  it('answers an authenticated unknown path with 404 in the { error } shape', async () => {
    let token: string;
    ({ app, tokens, token } = buildTestApp());

    const res = await app.inject({
      method: 'GET',
      url: '/no-such-path',
      headers: bearer(token),
    });

    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    // Exactly `{ error }` — none of Fastify's default `message`/`statusCode` keys.
    expect(res.json()).toEqual({ error: 'not found' });
  });

  it.each([
    ['GET', '/mytopic'], // the publish path, which only serves POST
    ['POST', '/mytopic/ws'], // a subscribe path, which only serves GET
    ['DELETE', '/mytopic'], // a method no route serves
  ])(
    'answers %s %s (unsupported method) with the same 404 shape',
    async (method, url) => {
      let token: string;
      ({ app, tokens, token } = buildTestApp());

      const res = await app.inject({
        method: method as 'GET' | 'POST' | 'DELETE',
        url,
        headers: bearer(token),
      });

      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'not found' });
    },
  );

  it('answers a non-upgrade GET to the ws route with the same 404 shape', async () => {
    // The subscribe route exists and serves GET, so a plain GET that never upgrades —
    // a browser opening the URL, or a proxy that dropped the `Upgrade` header — matches
    // it and never reaches the not-found handler. Without a handler of its own the
    // websocket plugin answers a bare, bodyless 404; the client must still find the
    // reason on `error` like it does everywhere else.
    let token: string;
    ({ app, tokens, token } = buildTestApp());

    const res = await app.inject({
      method: 'GET',
      url: '/mytopic/ws',
      headers: bearer(token),
    });

    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.json()).toEqual({ error: 'not found' });
  });

  it('still refuses an unauthenticated unknown route with 401, not 404', async () => {
    ({ app, tokens } = buildTestApp());

    const res = await app.inject({ method: 'GET', url: '/no-such-path' });

    // Auth runs before the not-found handler, so a client without a token learns it is
    // unauthorized before it learns whether the route exists.
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'a valid bearer token is required' });
  });

  it('leaves the health probe reachable', async () => {
    ({ app, tokens } = buildTestApp());

    const res = await app.inject({ method: 'GET', url: '/healthz' });

    expect(res.statusCode).toBe(200);
    expect((res.json() as { status: string }).status).toBe('ok');
  });
});

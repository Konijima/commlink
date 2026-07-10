import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { buildApp } from '../src/app.js';
import { AUTH_CHALLENGE, AUTH_RULE } from '../src/auth.js';
import { Broker } from '../src/broker.js';
import { TokenStore } from '../src/tokens.js';
import { bearer } from './helpers.js';

describe('bearer-token auth', () => {
  let app: FastifyInstance;
  let broker: Broker;
  let tokens: TokenStore;
  let token: string;

  beforeEach(async () => {
    broker = new Broker();
    tokens = new TokenStore();
    token = tokens.create('test');
    app = buildApp({ broker, tokens });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    tokens.close();
  });

  /** The token a client would send if it had guessed one — well-formed, never issued. */
  const WRONG_TOKEN = 'x'.repeat(43);

  describe('POST /:topic', () => {
    const publish = (headers: Record<string, string> = {}) =>
      app.inject({
        method: 'POST',
        url: '/mytopic',
        headers: { 'content-type': 'text/plain', ...headers },
        payload: 'hello',
      });

    it('accepts a publish carrying a valid token', async () => {
      expect((await publish(bearer(token))).statusCode).toBe(200);
    });

    it('is case-insensitive about the Bearer scheme', async () => {
      const res = await publish({ authorization: `bearer ${token}` });

      expect(res.statusCode).toBe(200);
    });

    // The headers are built inside the test: `token` is minted per-test, and a table
    // evaluated when the suite is collected would carry `undefined` instead.
    it.each([
      ['no Authorization header', () => ({})],
      ['an unissued token', () => bearer(WRONG_TOKEN)],
      ['an empty token', () => bearer('')],
      ['another scheme', () => ({ authorization: `Basic ${token}` })],
      ['no scheme at all', () => ({ authorization: token })],
      [
        'a token the header splits in two',
        () => ({ authorization: `Bearer ${token} x` }),
      ],
    ])('refuses a publish with %s', async (_name, headers) => {
      const res = await publish(headers());

      expect(res.statusCode).toBe(401);
      expect((res.json() as { error: string }).error).toBe(AUTH_RULE);
    });

    it('challenges an unauthorized client with WWW-Authenticate', async () => {
      const res = await publish();

      expect(res.statusCode).toBe(401);
      expect(res.headers['www-authenticate']).toBe(AUTH_CHALLENGE);
    });

    it('does not accept ?auth= on a publish, where a query string would be logged', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/mytopic?auth=${token}`,
        headers: { 'content-type': 'text/plain' },
        payload: 'hello',
      });

      expect(res.statusCode).toBe(401);
    });

    it('refuses an unauthorized publish before it reaches a subscriber', async () => {
      let delivered = 0;
      broker.subscribe(['mytopic'], () => (delivered += 1));

      expect((await publish()).statusCode).toBe(401);
      expect(delivered).toBe(0);
    });

    it('refuses an unauthorized publish before it validates the topic', async () => {
      // An invalid topic would be a `400`. Auth runs first, so a client with no token
      // learns nothing about which topics exist.
      const res = await app.inject({
        method: 'POST',
        url: '/bad.topic',
        headers: { 'content-type': 'text/plain' },
        payload: 'hello',
      });

      expect(res.statusCode).toBe(401);
    });
  });

  describe('GET /healthz', () => {
    it('answers a probe that carries no token', async () => {
      const res = await app.inject({ method: 'GET', url: '/healthz' });

      expect(res.statusCode).toBe(200);
      expect((res.json() as { status: string }).status).toBe('ok');
    });
  });

  describe('GET /:topic/json', () => {
    const subscribe = (url: string, headers: Record<string, string> = {}) =>
      app.inject({ method: 'GET', url, headers });

    it.each([
      ['no token', {}],
      ['an unissued token', bearer(WRONG_TOKEN)],
    ])('refuses a stream with %s', async (_name, headers) => {
      const res = await subscribe('/mytopic/json', headers as Record<string, string>);

      expect(res.statusCode).toBe(401);
      expect((res.json() as { error: string }).error).toBe(AUTH_RULE);
      expect(broker.listenerCount('mytopic')).toBe(0);
    });

    it('refuses an unissued token presented as ?auth=', async () => {
      const res = await subscribe(`/mytopic/json?auth=${WRONG_TOKEN}`);

      expect(res.statusCode).toBe(401);
      expect(broker.listenerCount('mytopic')).toBe(0);
    });

    it('refuses a stream before it validates the topic', async () => {
      const res = await subscribe('/bad.topic/json');

      expect(res.statusCode).toBe(401);
    });
  });

  // The subscribe socket needs a real handshake, which `app.inject` cannot perform.
  describe('GET /:topic/ws', () => {
    let wsBase: string;
    let sockets: WebSocket[];

    beforeEach(async () => {
      sockets = [];
      wsBase = (await app.listen({ port: 0, host: '127.0.0.1' })).replace(/^http/, 'ws');
    });

    afterEach(() => {
      for (const socket of sockets) socket.close();
    });

    function connect(path: string, headers: Record<string, string> = {}): WebSocket {
      const socket = new WebSocket(`${wsBase}${path}`, { headers });
      sockets.push(socket);
      return socket;
    }

    /** Resolve with the status of the HTTP response that refused the upgrade. */
    function refusal(socket: WebSocket): Promise<number> {
      return new Promise((resolve, reject) => {
        socket.once('unexpected-response', (_request, response) =>
          resolve(response.statusCode ?? 0),
        );
        socket.once('open', () => reject(new Error('the upgrade was not refused')));
        socket.once('error', reject);
      });
    }

    function opened(socket: WebSocket): Promise<void> {
      return new Promise((resolve, reject) => {
        socket.once('open', () => resolve());
        socket.once('error', reject);
      });
    }

    it('upgrades a socket carrying a valid token in the header', async () => {
      await expect(
        opened(connect('/mytopic/ws', bearer(token))),
      ).resolves.toBeUndefined();
    });

    it('upgrades a socket carrying a valid token as ?auth=, which a browser must use', async () => {
      await expect(opened(connect(`/mytopic/ws?auth=${token}`))).resolves.toBeUndefined();
    });

    it('replays with ?since= alongside ?auth=', async () => {
      await expect(
        opened(connect(`/mytopic/ws?since=0&auth=${token}`)),
      ).resolves.toBeUndefined();
    });

    it.each([
      ['no token', '/mytopic/ws', {}],
      ['an unissued token in the header', '/mytopic/ws', bearer(WRONG_TOKEN)],
      ['an unissued token as ?auth=', `/mytopic/ws?auth=${WRONG_TOKEN}`, {}],
      ['an empty ?auth=', '/mytopic/ws?auth=', {}],
    ])(
      'refuses the upgrade with %s, before the socket opens',
      async (_name, path, headers) => {
        const socket = connect(path, headers as Record<string, string>);

        // A `401` to the handshake, not a WebSocket close frame: the socket never existed.
        await expect(refusal(socket)).resolves.toBe(401);
        expect(broker.listenerCount('mytopic')).toBe(0);
      },
    );
  });

  describe('an app with no tokens', () => {
    let closed: FastifyInstance;

    beforeEach(async () => {
      closed = buildApp({ broker });
      await closed.ready();
    });

    afterEach(async () => {
      await closed.close();
    });

    it('serves the health probe', async () => {
      const res = await closed.inject({ method: 'GET', url: '/healthz' });

      expect(res.statusCode).toBe(200);
    });

    it('authorizes nobody to publish, rather than everybody', async () => {
      const res = await closed.inject({
        method: 'POST',
        url: '/mytopic',
        headers: { 'content-type': 'text/plain' },
        payload: 'hello',
      });

      expect(res.statusCode).toBe(401);
    });

    it('authorizes nobody to subscribe', async () => {
      const res = await closed.inject({ method: 'GET', url: '/mytopic/json' });

      expect(res.statusCode).toBe(401);
    });
  });
});

describe('a revoked token', () => {
  let app: FastifyInstance;
  let broker: Broker;
  let tokens: TokenStore;
  let revoked: string;
  let kept: string;
  let wsBase: string;
  let sockets: WebSocket[];

  beforeEach(async () => {
    broker = new Broker();
    tokens = new TokenStore();
    revoked = tokens.create('pixel');
    kept = tokens.create('laptop');
    app = buildApp({ broker, tokens });
    sockets = [];
    wsBase = (await app.listen({ port: 0, host: '127.0.0.1' })).replace(/^http/, 'ws');
  });

  afterEach(async () => {
    for (const socket of sockets) socket.close();
    await app.close();
    tokens.close();
  });

  const publish = (as: string, payload = 'hello') =>
    app.inject({
      method: 'POST',
      url: '/mytopic',
      headers: { 'content-type': 'text/plain', ...bearer(as) },
      payload,
    });

  function connect(path: string, headers: Record<string, string> = {}): WebSocket {
    const socket = new WebSocket(`${wsBase}${path}`, { headers });
    sockets.push(socket);
    return socket;
  }

  it('is refused where it worked a moment ago', async () => {
    expect((await publish(revoked)).statusCode).toBe(200);

    expect(tokens.revoke('pixel')).toBe(true);

    // Nothing caches the lookup, so the very next request already misses.
    const res = await publish(revoked);
    expect(res.statusCode).toBe(401);
    expect((res.json() as { error: string }).error).toBe(AUTH_RULE);
  });

  it('can no longer open a stream', async () => {
    tokens.revoke('pixel');
    const res = await app.inject({
      method: 'GET',
      url: '/mytopic/json',
      headers: bearer(revoked),
    });

    expect(res.statusCode).toBe(401);
    expect(broker.listenerCount('mytopic')).toBe(0);
  });

  it('can no longer upgrade a socket', async () => {
    tokens.revoke('pixel');
    const socket = connect('/mytopic/ws', bearer(revoked));

    const status = await new Promise<number>((resolve, reject) => {
      socket.once('unexpected-response', (_request, response) =>
        resolve(response.statusCode ?? 0),
      );
      socket.once('open', () => reject(new Error('the upgrade was not refused')));
      socket.once('error', reject);
    });

    expect(status).toBe(401);
    expect(broker.listenerCount('mytopic')).toBe(0);
  });

  it('leaves every other token working', async () => {
    tokens.revoke('pixel');

    expect((await publish(kept)).statusCode).toBe(200);
  });

  it('keeps a stream that was already open, until the subscriber disconnects', async () => {
    // A token is checked when a connection is made, not for as long as it is held. This
    // is the documented consequence, pinned here so it stays a decision rather than an
    // accident: an operator who must cut a live subscriber off restarts the server.
    const socket = connect('/mytopic/ws', bearer(revoked));
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });

    tokens.revoke('pixel');

    const frame = new Promise<string>((resolve) => {
      socket.once('message', (data) => resolve(data.toString()));
    });
    expect((await publish(kept, 'still here')).statusCode).toBe(200);

    expect((JSON.parse(await frame) as { message: string }).message).toBe('still here');
  });
});

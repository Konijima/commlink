import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { Broker } from '../src/broker.js';
import type { TokenStore } from '../src/tokens.js';
import { bearer, buildTestApp } from './helpers.js';

/**
 * Short enough that a test finishes in milliseconds. The revocation sweep rides the
 * keepalive interval, so a revoke is noticed within one tick. The production interval
 * is 45s.
 */
const INTERVAL_MS = 25;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('revoking a token drops its live WebSocket subscriber', () => {
  let app: FastifyInstance;
  let broker: Broker;
  let wsBase: string;
  let sockets: WebSocket[];
  let tokens: TokenStore;
  let token: string;

  beforeEach(async () => {
    broker = new Broker();
    ({ app, tokens, token } = buildTestApp({ broker, keepaliveIntervalMs: INTERVAL_MS }));
    sockets = [];

    const httpBase = await app.listen({ port: 0, host: '127.0.0.1' });
    wsBase = httpBase.replace(/^http/, 'ws');
  });

  afterEach(async () => {
    for (const socket of sockets) socket.terminate();
    await app.close();
    tokens.close();
  });

  async function connect(topic: string, auth: string): Promise<WebSocket> {
    const socket = new WebSocket(`${wsBase}/${topic}/ws`, { headers: bearer(auth) });
    sockets.push(socket);

    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    await vi.waitFor(() => expect(broker.listenerCount(topic)).toBe(1));

    return socket;
  }

  it('closes the socket with a reason once its token is revoked', async () => {
    const socket = await connect('alpha', token);

    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      socket.once('close', (code, reason) =>
        resolve({ code, reason: reason.toString() }),
      );
    });

    expect(tokens.revoke('test')).toBe(true);

    const { code, reason } = await closed;
    // The same policy-violation code a refused subscribe uses, and a reason that names
    // why — a bare drop would look like any dead connection.
    expect(code).toBe(1008);
    expect(reason).toBe('token revoked');
    // The client sees the close frame a moment before the server finishes tearing down
    // its side and detaches from the broker.
    await vi.waitFor(() => expect(broker.listenerCount('alpha')).toBe(0));
  });

  it('detaches every topic of a multiplexed subscriber whose token is revoked', async () => {
    const socket = new WebSocket(`${wsBase}/alpha,beta/ws`, { headers: bearer(token) });
    sockets.push(socket);
    await new Promise<void>((resolve) => socket.once('open', () => resolve()));
    await vi.waitFor(() => expect(broker.listenerCount('beta')).toBe(1));

    tokens.revoke('test');

    await vi.waitFor(() => {
      expect(broker.listenerCount('alpha')).toBe(0);
      expect(broker.listenerCount('beta')).toBe(0);
    });
  });

  it('leaves a subscriber whose token is still valid attached', async () => {
    const other = tokens.create('other');
    const revoked = await connect('alpha', token);
    const kept = await connect('beta', other);

    tokens.revoke('test');
    await new Promise<void>((resolve) => revoked.once('close', () => resolve()));

    // Several intervals in which the sweep could have wrongly dropped the valid one.
    await sleep(INTERVAL_MS * 4);

    expect(kept.readyState).toBe(WebSocket.OPEN);
    expect(broker.listenerCount('beta')).toBe(1);
  });
});

describe('revoking a token ends its live JSON stream', () => {
  let app: FastifyInstance;
  let broker: Broker;
  let httpBase: string;
  let controllers: AbortController[];
  let tokens: TokenStore;
  let token: string;

  beforeEach(async () => {
    broker = new Broker();
    ({ app, tokens, token } = buildTestApp({ broker, keepaliveIntervalMs: INTERVAL_MS }));
    controllers = [];

    httpBase = await app.listen({ port: 0, host: '127.0.0.1' });
  });

  afterEach(async () => {
    for (const controller of controllers) controller.abort();
    await app.close();
    tokens.close();
  });

  async function openStream(topic: string, auth: string): Promise<Response> {
    const controller = new AbortController();
    controllers.push(controller);

    const response = await fetch(`${httpBase}/${topic}/json`, {
      headers: bearer(auth),
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(broker.listenerCount(topic)).toBe(1));

    return response;
  }

  it('ends the response once the token is revoked', async () => {
    const response = await openStream('alpha', token);
    const reader = response.body!.getReader();

    // Drain in the background. The read resolves `done` when the server ends the stream,
    // which is what a revoked reader sees: the socket closes cleanly, not mid-line.
    const drained = (async () => {
      for (;;) {
        const { done } = await reader.read();
        if (done) return;
      }
    })();

    tokens.revoke('test');

    await drained;
    await vi.waitFor(() => expect(broker.listenerCount('alpha')).toBe(0));
  });

  it('leaves a reader whose token is still valid streaming', async () => {
    const other = tokens.create('other');
    const revoked = await openStream('alpha', token);
    const kept = await openStream('beta', other);

    const revokedReader = revoked.body!.getReader();
    const drained = (async () => {
      for (;;) {
        const { done } = await revokedReader.read();
        if (done) return;
      }
    })();

    tokens.revoke('test');
    await drained;

    // The kept reader must still be receiving keepalive lines several ticks later.
    void kept.body!.getReader();
    await sleep(INTERVAL_MS * 4);

    expect(broker.listenerCount('beta')).toBe(1);
  });
});

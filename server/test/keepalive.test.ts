import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { Broker } from '../src/broker.js';
import { everyInterval } from '../src/keepalive.js';
import type { Message } from '../src/message.js';
import type { TokenStore } from '../src/tokens.js';
import { bearer, buildTestApp } from './helpers.js';

/**
 * Short enough that a test finishes in milliseconds, long enough that a slow machine
 * does not tick twice where the test expects once. The production interval is 45s.
 */
const INTERVAL_MS = 25;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('everyInterval', () => {
  it('does not hold the process open on its own', () => {
    const app = Fastify({ logger: false });
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

    everyInterval(app, INTERVAL_MS, () => {});

    const timer = setIntervalSpy.mock.results[0]?.value as NodeJS.Timeout;
    expect(timer.hasRef()).toBe(false);

    setIntervalSpy.mockRestore();
    clearInterval(timer);
  });

  it('stops ticking once the server closes', async () => {
    const app = Fastify({ logger: false });
    let ticks = 0;

    everyInterval(app, INTERVAL_MS, () => {
      ticks += 1;
    });
    await app.ready();

    await vi.waitFor(() => expect(ticks).toBeGreaterThan(0));
    await app.close();

    // Had the timer outlived the app, several more intervals would land here.
    const afterClose = ticks;
    await sleep(INTERVAL_MS * 4);
    expect(ticks).toBe(afterClose);
  });
});

describe('keepalive on GET /:topic/ws', () => {
  let app: FastifyInstance;
  let broker: Broker;
  let httpBase: string;
  let wsBase: string;
  let sockets: WebSocket[];
  let tokens: TokenStore;
  let token: string;

  beforeEach(async () => {
    broker = new Broker();
    ({ app, tokens, token } = buildTestApp({ broker, keepaliveIntervalMs: INTERVAL_MS }));
    sockets = [];

    httpBase = await app.listen({ port: 0, host: '127.0.0.1' });
    wsBase = httpBase.replace(/^http/, 'ws');
  });

  afterEach(async () => {
    for (const socket of sockets) socket.terminate();
    await app.close();
    tokens.close();
  });

  /** Open a subscriber socket, authenticated the way a WebSocket client has to be. */
  function open(path: string): WebSocket {
    const socket = new WebSocket(`${wsBase}/${path}`, { headers: bearer(token) });
    sockets.push(socket);
    return socket;
  }

  async function connect(topic: string): Promise<WebSocket> {
    const socket = open(`${topic}/ws`);

    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    await vi.waitFor(() => expect(broker.listenerCount(topic)).toBe(1));

    return socket;
  }

  /** Counts the ping frames the server sends; `ws` answers each one by itself. */
  function countPings(socket: WebSocket): () => number {
    let pings = 0;
    socket.on('ping', () => {
      pings += 1;
    });
    return () => pings;
  }

  it('pings an idle subscriber, repeatedly', async () => {
    const socket = await connect('alpha');
    const pings = countPings(socket);

    await vi.waitFor(() => expect(pings()).toBeGreaterThanOrEqual(2));
  });

  it('keeps a subscriber that answers the pings', async () => {
    const socket = await connect('alpha');
    const pings = countPings(socket);

    // `ws` pongs automatically, so this client stays alive across many intervals.
    await sleep(INTERVAL_MS * 6);

    expect(pings()).toBeGreaterThanOrEqual(2);
    expect(socket.readyState).toBe(WebSocket.OPEN);
    expect(broker.listenerCount('alpha')).toBe(1);
  });

  it('still delivers messages to a subscriber that has been pinged', async () => {
    const socket = await connect('alpha');
    const pings = countPings(socket);
    await vi.waitFor(() => expect(pings()).toBeGreaterThanOrEqual(1));

    const frame = new Promise<Message>((resolve) => {
      socket.once('message', (data) => resolve(JSON.parse(data.toString()) as Message));
    });
    await fetch(`${httpBase}/alpha`, {
      method: 'POST',
      headers: bearer(token),
      body: 'hello',
    });

    expect((await frame).message).toBe('hello');
  });

  it('terminates a subscriber that stops answering, detaching it from the broker', async () => {
    const socket = await connect('alpha');

    // A paused socket never reads the ping, so `ws` never pongs — the same shape as a
    // peer that vanished without closing the TCP connection.
    socket.pause();

    await vi.waitFor(() => expect(broker.listenerCount('alpha')).toBe(0), {
      timeout: 2_000,
    });
  });

  it('detaches every topic of a multiplexed subscriber that stops answering', async () => {
    const socket = open('alpha,beta/ws');
    await new Promise<void>((resolve) => socket.once('open', () => resolve()));
    await vi.waitFor(() => expect(broker.listenerCount('beta')).toBe(1));

    socket.pause();

    await vi.waitFor(
      () => {
        expect(broker.listenerCount('alpha')).toBe(0);
        expect(broker.listenerCount('beta')).toBe(0);
      },
      { timeout: 2_000 },
    );
  });

  it('does not ping a socket it refused', async () => {
    const socket = open('bad.topic/ws');
    const pings = countPings(socket);

    await new Promise<void>((resolve) => socket.once('close', () => resolve()));
    await sleep(INTERVAL_MS * 3);

    expect(pings()).toBe(0);
  });
});

describe('keepalive on GET /:topic/json', () => {
  let app: FastifyInstance;
  let broker: Broker;
  let httpBase: string;
  let controllers: AbortController[];
  let closed: boolean;
  let tokens: TokenStore;
  let token: string;

  beforeEach(async () => {
    broker = new Broker();
    ({ app, tokens, token } = buildTestApp({ broker, keepaliveIntervalMs: INTERVAL_MS }));
    controllers = [];
    closed = false;

    httpBase = await app.listen({ port: 0, host: '127.0.0.1' });
  });

  afterEach(async () => {
    for (const controller of controllers) controller.abort();
    await closeApp();
    tokens.close();
  });

  async function closeApp(): Promise<void> {
    if (closed) return;
    closed = true;
    await app.close();
  }

  /** Accumulates the raw response body, blank keepalive lines and all. */
  async function openStream(topic: string): Promise<{ readonly raw: string }> {
    const controller = new AbortController();
    controllers.push(controller);

    const response = await fetch(`${httpBase}/${topic}/json`, {
      headers: bearer(token),
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(broker.listenerCount(topic.split(',')[0])).toBe(1));

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const state = { raw: '' };

    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          state.raw += decoder.decode(value, { stream: true });
        }
      } catch {
        // The abort in `afterEach`, or the server ending the response. Neither is a
        // failure: what the test asserts on is the text read before that point.
      }
    })();

    return state;
  }

  function publish(topic: string, body: string) {
    return fetch(`${httpBase}/${topic}`, {
      method: 'POST',
      headers: bearer(token),
      body,
    });
  }

  it('writes a blank line to an idle stream, repeatedly', async () => {
    const stream = await openStream('alpha');

    // Nothing but blank lines: an idle stream carries no messages, only keepalives.
    await vi.waitFor(() => expect(stream.raw).toMatch(/^\n{2,}$/));
  });

  it('keeps message framing intact around the blank lines', async () => {
    const stream = await openStream('alpha');
    await vi.waitFor(() => expect(stream.raw).toContain('\n'));

    await publish('alpha', 'hello');
    await vi.waitFor(() => expect(stream.raw).toContain('hello'));

    // What a client does: split on newlines, ignore the empty ones, parse the rest.
    const messages = stream.raw
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Message);

    expect(messages).toHaveLength(1);
    expect(messages[0].message).toBe('hello');
    expect(messages[0].topic).toBe('alpha');
  });

  it('stops the keepalive when the client disconnects', async () => {
    await openStream('alpha');

    controllers[0].abort();

    // A heartbeat still writing to a detached response would keep the listener alive.
    await vi.waitFor(() => expect(broker.listenerCount('alpha')).toBe(0));
    await sleep(INTERVAL_MS * 3);
    expect(broker.listenerCount('alpha')).toBe(0);
  });

  it('stops the keepalive when the server shuts down', async () => {
    const stream = await openStream('alpha');
    await vi.waitFor(() => expect(stream.raw).toContain('\n'));

    // Would throw ERR_STREAM_WRITE_AFTER_END if the timer outlived the response.
    await closeApp();
    await sleep(INTERVAL_MS * 4);

    expect(broker.listenerCount('alpha')).toBe(0);
  });
});

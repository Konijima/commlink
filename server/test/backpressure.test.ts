import type { IncomingMessage } from 'node:http';
import { get } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { buildApp } from '../src/app';
import { Broker } from '../src/broker';
import type { Message } from '../src/message';

/**
 * Small enough that a single message dwarfs it once the connection stops draining.
 * The production limit is 1 MiB; `uses the default limit` is the test that fills it.
 */
const SMALL_LIMIT = 1024;

/** One message, large enough to overrun the limit many times over. */
const PAYLOAD = 'x'.repeat(200_000);

/**
 * Longer than any test here runs. The keepalive drops an unresponsive subscriber all
 * by itself, so it is held off: what these tests watch must be backpressure or nothing.
 */
const KEEPALIVE_OFF_MS = 600_000;

/**
 * A stalled connection only accumulates once the kernel's buffers are full, which on
 * a loopback socket takes a few megabytes. This is the ceiling on how many messages a
 * test will push to get there; the loops stop as soon as the subscriber is dropped.
 */
const MAX_PUBLISHES = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Long enough for a `terminate()` or `destroy()` to have fired `close` and detached
 * the subscriber, so a loop that counts publishes stops on the right one.
 */
const SETTLE_MS = 5;

describe('backpressure on GET /:topic/ws', () => {
  let app: FastifyInstance;
  let broker: Broker;
  let httpBase: string;
  let wsBase: string;
  let sockets: WebSocket[];

  async function start(maxBufferedBytes?: number): Promise<void> {
    broker = new Broker();
    app = buildApp({ broker, keepaliveIntervalMs: KEEPALIVE_OFF_MS, maxBufferedBytes });
    httpBase = await app.listen({ port: 0, host: '127.0.0.1' });
    wsBase = httpBase.replace(/^http/, 'ws');
  }

  beforeEach(() => {
    sockets = [];
  });

  afterEach(async () => {
    for (const socket of sockets) socket.terminate();
    await app.close();
  });

  async function connect(topic: string): Promise<WebSocket> {
    const socket = new WebSocket(`${wsBase}/${topic}/ws`);
    sockets.push(socket);

    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    await vi.waitFor(() => expect(broker.listenerCount(topic)).toBe(1));

    return socket;
  }

  async function publish(topic: string, body: string = PAYLOAD): Promise<void> {
    const response = await fetch(`${httpBase}/${topic}`, { method: 'POST', body });
    expect(response.status).toBe(200);
    await response.arrayBuffer();
  }

  /** Publish until `topic` has `remaining` subscribers left, and say how many it took. */
  async function publishUntilDropped(topic: string, remaining = 0): Promise<number> {
    for (let sent = 1; sent <= MAX_PUBLISHES; sent += 1) {
      await publish(topic);
      await sleep(SETTLE_MS);
      if (broker.listenerCount(topic) === remaining) return sent;
    }

    throw new Error(`still ${broker.listenerCount(topic)} subscribed after ${MAX_PUBLISHES}`);
  }

  it('drops a subscriber that stops reading, detaching it from the broker', async () => {
    await start(SMALL_LIMIT);
    const socket = await connect('alpha');

    // A paused socket never drains, so the server's queue for it only grows — the
    // shape of a phone that fell off the network without closing the connection.
    socket.pause();

    await publishUntilDropped('alpha');
    expect(broker.listenerCount('alpha')).toBe(0);
  });

  it('keeps a subscriber that reads what it is sent', async () => {
    await start(SMALL_LIMIT);
    const socket = await connect('alpha');

    let received = 0;
    socket.on('message', () => {
      received += 1;
    });

    // The same traffic that drops a stalled subscriber. A reader drains between
    // messages, so its backlog never stands still long enough to count against it.
    for (let sent = 0; sent < 10; sent += 1) await publish('alpha');

    await vi.waitFor(() => expect(received).toBe(10));
    expect(socket.readyState).toBe(WebSocket.OPEN);
    expect(broker.listenerCount('alpha')).toBe(1);
  });

  it('drops only the stalled subscriber, leaving the others on the topic', async () => {
    await start(SMALL_LIMIT);
    const healthy = await connect('alpha');
    const stalled = new WebSocket(`${wsBase}/alpha/ws`);
    sockets.push(stalled);
    await new Promise<void>((resolve) => stalled.once('open', () => resolve()));
    await vi.waitFor(() => expect(broker.listenerCount('alpha')).toBe(2));

    stalled.pause();
    await publishUntilDropped('alpha', 1);

    // The survivor is still a working subscriber, not merely still attached.
    const frame = new Promise<Message>((resolve) => {
      healthy.once('message', (data) => resolve(JSON.parse(data.toString()) as Message));
    });
    await publish('alpha', 'still here');

    expect((await frame).message).toBe('still here');
    expect(broker.listenerCount('alpha')).toBe(1);
  });

  it('bounds a stalled subscriber at the default limit when none is given', async () => {
    await start();
    const socket = await connect('alpha');
    socket.pause();

    // Nothing is passed to `buildApp`, so this fills MAX_BUFFERED_BYTES itself: proof
    // the shipped default is wired to the route, not just the one the tests inject.
    await publishUntilDropped('alpha');
    expect(broker.listenerCount('alpha')).toBe(0);
  });
});

describe('backpressure on GET /:topic/json', () => {
  let app: FastifyInstance;
  let broker: Broker;
  let httpBase: string;
  let responses: IncomingMessage[];

  async function start(keepaliveIntervalMs: number): Promise<void> {
    broker = new Broker();
    app = buildApp({ broker, keepaliveIntervalMs, maxBufferedBytes: SMALL_LIMIT });
    httpBase = await app.listen({ port: 0, host: '127.0.0.1' });
  }

  beforeEach(() => {
    responses = [];
  });

  afterEach(async () => {
    for (const response of responses) response.destroy();
    await app.close();
  });

  async function openStream(topic: string): Promise<IncomingMessage> {
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const request = get(`${httpBase}/${topic}/json`, resolve);
      request.on('error', reject);
    });
    responses.push(response);

    expect(response.statusCode).toBe(200);
    await vi.waitFor(() => expect(broker.listenerCount(topic)).toBe(1));

    return response;
  }

  async function publish(topic: string, body: string = PAYLOAD): Promise<void> {
    const response = await fetch(`${httpBase}/${topic}`, { method: 'POST', body });
    expect(response.status).toBe(200);
    await response.arrayBuffer();
  }

  /** Publish until nothing is subscribed to `topic`, and say how many it took. */
  async function publishUntilDropped(topic: string): Promise<number> {
    for (let sent = 1; sent <= MAX_PUBLISHES; sent += 1) {
      await publish(topic);
      await sleep(SETTLE_MS);
      if (broker.listenerCount(topic) === 0) return sent;
    }

    throw new Error(`still subscribed after ${MAX_PUBLISHES} messages`);
  }

  it('drops a reader that stops reading, detaching it from the broker', async () => {
    await start(KEEPALIVE_OFF_MS);
    const response = await openStream('alpha');

    // An unread response fills its buffer and stops draining the socket.
    response.pause();

    await publishUntilDropped('alpha');
    expect(broker.listenerCount('alpha')).toBe(0);
  });

  it('keeps a reader that keeps up', async () => {
    await start(KEEPALIVE_OFF_MS);
    const response = await openStream('alpha');

    let bytes = 0;
    response.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
    });

    for (let sent = 0; sent < 10; sent += 1) await publish('alpha');

    await vi.waitFor(() => expect(bytes).toBeGreaterThanOrEqual(10 * PAYLOAD.length));
    expect(response.destroyed).toBe(false);
    expect(broker.listenerCount('alpha')).toBe(1);
  });

  it('drops a stalled reader once it stops receiving messages', async () => {
    // A stream has no pong to withhold: were it not for the keepalive's own check, a
    // reader that stalls and then goes quiet would hold its backlog for good. Reaching
    // that state takes knowing which message crosses the limit — it is the one before
    // the message whose delivery drops the reader, so measure it, then stop one short.
    await start(KEEPALIVE_OFF_MS);
    const first = await openStream('alpha');
    first.pause();
    const untilDropped = await publishUntilDropped('alpha');
    expect(untilDropped).toBeGreaterThan(1);
    await app.close();

    await start(25);
    const second = await openStream('alpha');
    second.pause();

    // One message short of the delivery check ever firing: the reader is over the limit
    // and no further message will be delivered to it. Only the keepalive can drop it now.
    for (let sent = 0; sent < untilDropped - 1; sent += 1) {
      await publish('alpha');
      await sleep(SETTLE_MS);
    }

    await vi.waitFor(() => expect(broker.listenerCount('alpha')).toBe(0), { timeout: 2_000 });
  });
});

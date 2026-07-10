import type { IncomingMessage, ServerResponse } from 'node:http';
import { get } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { MAX_BUFFERED_BYTES } from '../src/backpressure.js';
import { Broker } from '../src/broker.js';
import { MessageStore } from '../src/store.js';
import type { TokenStore } from '../src/tokens.js';
import { bearer, buildTestApp } from './helpers.js';

/**
 * A `?since=` replay is written to a subscriber through the same path a live message
 * is, and dropped by the same buffer limit. So a backlog too large to hand a reader
 * that is not keeping up hangs up on it partway through, rather than growing the heap
 * without bound — the live behaviour, extended to the catch-up a reconnecting client
 * asks for. These pin that on both subscribe routes.
 */

/** Small enough that a stalled reader's backlog passes it well before a big replay ends. */
const SMALL_LIMIT = 1024;

/** One replayed message, large enough that a handful fill a loopback socket's buffers. */
const PAYLOAD = 'x'.repeat(200_000);

/**
 * A backlog far larger than any loopback socket's buffers can absorb — ~40 MiB at
 * `PAYLOAD` each. The server writes the whole replay in one synchronous pass, during
 * which the in-process reader cannot run to drain it, so the send buffer fills and the
 * backlog passes the limit regardless of how promptly the reader would have stalled.
 */
const OVERFLOWING_BACKLOG = 200;

/** A backlog small enough to replay in full to a reader that keeps up. */
const DRAINABLE_BACKLOG = 20;

/**
 * The seeded messages carry `PAYLOAD`, which is larger than the shipped 4 KB publish
 * limit; raise it so a body that size is admitted. Nothing here publishes over HTTP —
 * the store is seeded directly — but the app still validates the option against it.
 */
const BODY_LIMIT_OFF = PAYLOAD.length;

/**
 * Held off, so the only thing that can drop a subscriber in these tests is the replay
 * meeting the buffer limit: nothing is published live, and no ping goes unanswered.
 */
const KEEPALIVE_OFF_MS = 600_000;

const SETTLE_MS = 5;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error(`condition still false after ${timeoutMs}ms`);
    await sleep(SETTLE_MS);
  }
}

describe('replay backpressure', () => {
  let app: FastifyInstance;
  let broker: Broker;
  let store: MessageStore;
  let tokens: TokenStore;
  let token: string;
  let httpBase: string;
  let wsBase: string;
  let held: ServerResponse[];
  let sockets: WebSocket[];
  let readers: IncomingMessage[];

  async function start(maxBufferedBytes = SMALL_LIMIT): Promise<void> {
    broker = new Broker();
    store = new MessageStore();
    ({ app, tokens, token } = buildTestApp({
      broker,
      store,
      keepaliveIntervalMs: KEEPALIVE_OFF_MS,
      maxBufferedBytes,
      maxBodyBytes: BODY_LIMIT_OFF,
    }));

    // The `/json` route hijacks its response and writes onto it directly, so that raw
    // response is what the server measures the backlog against. Holding it lets a test
    // read whether the server destroyed it, rather than infer it from the reader.
    held = [];
    app.addHook('onRequest', async (request, reply) => {
      if (request.url.includes('/json')) held.push(reply.raw);
    });

    httpBase = await app.listen({ port: 0, host: '127.0.0.1' });
    wsBase = httpBase.replace(/^http/, 'ws');
  }

  /**
   * Store `count` messages on `topic`, stamped now so the retention sweep that runs as
   * the app came up does not prune them before a `?since=0` replay reaches them.
   */
  function seedBacklog(topic: string, count: number, body: string): void {
    const timestamp = Math.floor(Date.now() / 1000);
    for (let i = 0; i < count; i += 1) {
      store.append({
        id: `${topic}-${i}`,
        topic,
        title: null,
        message: body,
        priority: 3,
        tags: [],
        timestamp,
      });
    }
  }

  beforeEach(() => {
    sockets = [];
    readers = [];
  });

  afterEach(async () => {
    for (const socket of sockets) socket.terminate();
    for (const reader of readers) reader.destroy();
    await app.close();
    // The store was injected, so closing it is this test's job, not the app's.
    store.close();
    tokens.close();
  });

  interface Stream {
    reader: IncomingMessage;
    response: ServerResponse;
  }

  /** Open a `/json` stream and hand back both ends of it. */
  async function openJsonStream(topic: string, since: number): Promise<Stream> {
    const reader = await new Promise<IncomingMessage>((resolve, reject) => {
      const request = get(
        `${httpBase}/${topic}/json?since=${since}`,
        { headers: bearer(token) },
        resolve,
      );
      request.on('error', reject);
    });
    readers.push(reader);
    expect(reader.statusCode).toBe(200);

    const response = held.at(-1);
    if (response === undefined)
      throw new Error('the server never saw the stream request');

    return { reader, response };
  }

  describe('GET /:topic/json', () => {
    it('drops a stalled reader partway through a replay too large to buffer', async () => {
      await start();
      seedBacklog('alpha', OVERFLOWING_BACKLOG, PAYLOAD);

      // No 'data' listener is attached, so the reader never drains: the whole replay is
      // the server's to hold, and it passes the limit long before the backlog is spent.
      const { response } = await openJsonStream('alpha', 0);

      await waitUntil(() => broker.listenerCount('alpha') === 0);
      expect(response.destroyed).toBe(true);
    });

    it('replays the whole backlog to a reader that keeps up', async () => {
      // A reader that drains never accumulates, so the full backlog reaches it. The
      // shipped buffer limit is used here, not the small one, to prove the replay is
      // what is exercised rather than a limit tightened until anything would trip it.
      await start(MAX_BUFFERED_BYTES);
      seedBacklog('alpha', DRAINABLE_BACKLOG, 'msg');

      const { reader } = await openJsonStream('alpha', 0);

      // Every message is one newline-terminated line, and the keepalive that would add
      // a blank one is held off, so counting newlines counts messages delivered.
      let lines = 0;
      reader.on('data', (chunk: Buffer) => {
        for (const byte of chunk) if (byte === 0x0a) lines += 1;
      });

      await waitUntil(() => lines === DRAINABLE_BACKLOG);
      expect(reader.destroyed).toBe(false);
      expect(broker.listenerCount('alpha')).toBe(1);
    });
  });

  describe('GET /:topic/ws', () => {
    it('drops a stalled subscriber partway through a replay too large to buffer', async () => {
      await start();
      seedBacklog('alpha', OVERFLOWING_BACKLOG, PAYLOAD);

      const socket = new WebSocket(`${wsBase}/alpha/ws?since=0`, {
        headers: bearer(token),
      });
      sockets.push(socket);
      await new Promise<void>((resolve, reject) => {
        socket.once('open', () => resolve());
        socket.once('error', reject);
      });
      // The server writes the whole replay synchronously either way; pausing keeps the
      // shape of a phone that stalled, so nothing drains what the drop is about.
      socket.pause();

      await waitUntil(() => broker.listenerCount('alpha') === 0);
    });

    it('replays the whole backlog to a subscriber that keeps up', async () => {
      await start(MAX_BUFFERED_BYTES);
      seedBacklog('alpha', DRAINABLE_BACKLOG, 'msg');

      // The 'message' listener is attached before the socket opens, since the server
      // may write the replay in the same turn the handshake completes.
      let received = 0;
      const socket = new WebSocket(`${wsBase}/alpha/ws?since=0`, {
        headers: bearer(token),
      });
      sockets.push(socket);
      socket.on('message', () => {
        received += 1;
      });

      await waitUntil(() => received === DRAINABLE_BACKLOG);
      expect(socket.readyState).toBe(WebSocket.OPEN);
      expect(broker.listenerCount('alpha')).toBe(1);
    });
  });
});

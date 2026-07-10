import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { Broker } from '../src/broker.js';
import {
  MAX_SUBSCRIBE_TOPICS,
  MAX_TOPIC_LENGTH,
  SINCE_RULE,
  TOPIC_LIST_RULE,
} from '../src/message.js';
import type { Message } from '../src/message.js';
import type { TokenStore } from '../src/tokens.js';
import { bearer, buildTestApp } from './helpers.js';

describe('GET /:topic/json', () => {
  let app: FastifyInstance;
  let broker: Broker;
  let httpBase: string;
  let controllers: AbortController[];
  let closed: boolean;
  let tokens: TokenStore;
  let token: string;

  beforeEach(async () => {
    broker = new Broker();
    ({ app, tokens, token } = buildTestApp({ broker }));
    controllers = [];
    closed = false;

    // A real socket on an ephemeral port: `app.inject` buffers the whole response,
    // and streaming it line by line is precisely what these tests are about.
    httpBase = await app.listen({ port: 0, host: '127.0.0.1' });
  });

  afterEach(async () => {
    for (const controller of controllers) controller.abort();
    await closeApp();
    tokens.close();
  });

  /** GET an authenticated stream, the way any HTTP subscriber has to. */
  function subscribe(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${httpBase}/${path}`, { ...init, headers: bearer(token) });
  }

  async function closeApp(): Promise<void> {
    if (closed) return;
    closed = true;
    await app.close();
  }

  /** Reads whole NDJSON lines out of a streaming response body, one message at a time. */
  function lines(response: Response): { next: () => Promise<Message> } {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    return {
      async next(): Promise<Message> {
        for (;;) {
          const newline = buffer.indexOf('\n');
          if (newline !== -1) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            return JSON.parse(line) as Message;
          }

          const { value, done } = await reader.read();
          if (done) throw new Error('stream ended before a complete line arrived');
          buffer += decoder.decode(value, { stream: true });
        }
      },
    };
  }

  /**
   * Open a stream on one topic, or on a comma-separated list of them, optionally with
   * a query string, and resolve once it is attached.
   */
  async function open(topicList: string, query = ''): Promise<Response> {
    // One `broker.subscribe` call attaches the listener to every topic at once, so
    // seeing it on the first proves it landed on all of them.
    const [first] = topicList.split(',');
    const before = broker.listenerCount(first);
    const controller = new AbortController();
    controllers.push(controller);

    // Resolves as soon as the headers are flushed; the body arrives line by line.
    const response = await subscribe(`${topicList}/json${query}`, {
      signal: controller.signal,
    });

    await vi.waitFor(() => expect(broker.listenerCount(first)).toBeGreaterThan(before));

    return response;
  }

  function publish(topic: string, body: string, headers: Record<string, string> = {}) {
    return fetch(`${httpBase}/${topic}`, {
      method: 'POST',
      headers: { ...bearer(token), 'content-type': 'text/plain', ...headers },
      body,
    });
  }

  /** Publish and resolve with the message the server stored, whose `timestamp` bounds a replay. */
  async function publishMessage(topic: string, body: string): Promise<Message> {
    const response = await publish(topic, body);
    expect(response.status).toBe(200);
    return (await response.json()) as Message;
  }

  it('streams a published message as one JSON line', async () => {
    const stream = lines(await open('alpha'));

    const res = await publish('alpha', 'hello', {
      'x-title': 'Deploy finished',
      'x-priority': '5',
      'x-tags': 'ci,deploy',
    });

    expect(res.status).toBe(200);
    expect(await stream.next()).toEqual(await res.json());
  });

  it('answers with a no-store newline-delimited JSON stream', async () => {
    const response = await open('alpha');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/x-ndjson');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('writes each line carrying exactly the documented fields', async () => {
    const stream = lines(await open('alpha'));

    await publish('alpha', 'hello');

    const message = await stream.next();
    expect(Object.keys(message).sort()).toEqual([
      'id',
      'message',
      'priority',
      'tags',
      'timestamp',
      'title',
      'topic',
    ]);
    expect(message.topic).toBe('alpha');
    expect(message.message).toBe('hello');
  });

  it('writes one line per message, in publication order', async () => {
    const stream = lines(await open('alpha'));

    await publish('alpha', 'first');
    await publish('alpha', 'second');

    expect((await stream.next()).message).toBe('first');
    expect((await stream.next()).message).toBe('second');
  });

  it('fans one message out to every stream on the topic', async () => {
    const first = lines(await open('alpha'));
    const second = lines(await open('alpha'));
    expect(broker.listenerCount('alpha')).toBe(2);

    await publish('alpha', 'hello');

    expect(await first.next()).toEqual(await second.next());
  });

  it('carries the same message a WebSocket subscriber receives', async () => {
    const socket = new WebSocket(`${httpBase.replace(/^http/, 'ws')}/alpha/ws`, {
      headers: bearer(token),
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    await vi.waitFor(() => expect(broker.listenerCount('alpha')).toBe(1));

    const stream = lines(await open('alpha'));
    const frame = new Promise<Message>((resolve) => {
      socket.once('message', (data) => resolve(JSON.parse(data.toString()) as Message));
    });

    await publish('alpha', 'hello');

    expect(await stream.next()).toEqual(await frame);
    socket.close();
  });

  it('does not deliver messages published to another topic', async () => {
    const stream = lines(await open('alpha'));

    // `beta` fans out first; had it leaked, it would arrive as the first line.
    await publish('beta', 'wrong topic');
    await publish('alpha', 'right topic');

    expect((await stream.next()).message).toBe('right topic');
  });

  it('does not replay messages published before the stream opened', async () => {
    await publish('alpha', 'published while nobody listened');

    const stream = lines(await open('alpha'));
    await publish('alpha', 'published while listening');

    expect((await stream.next()).message).toBe('published while listening');
  });

  it('writes no line for a publish the server rejected', async () => {
    const stream = lines(await open('alpha'));

    const rejected = await publish('alpha', 'hello', { 'x-priority': '9' });
    expect(rejected.status).toBe(400);
    await publish('alpha', 'accepted');

    expect((await stream.next()).message).toBe('accepted');
  });

  it('detaches the subscriber when the client disconnects', async () => {
    await open('alpha');

    controllers[controllers.length - 1].abort();

    await vi.waitFor(() => expect(broker.listenerCount('alpha')).toBe(0));
  });

  it.each(['bad.topic', 'bad topic', 'a'.repeat(65), 'healthz'])(
    'rejects a stream of invalid topic %j with 400',
    async (topic) => {
      const response = await subscribe(`${encodeURIComponent(topic)}/json`);

      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toMatch(/^topic must be/);
      expect(broker.listenerCount(topic)).toBe(0);
    },
  );

  describe('?since= replay', () => {
    it('replays a message published before the stream opened', async () => {
      const missed = await publishMessage('alpha', 'published while offline');

      const stream = lines(await open('alpha', `?since=${missed.timestamp}`));

      expect(await stream.next()).toEqual(missed);
    });

    it('replays the backlog in publication order, then streams live messages', async () => {
      const first = await publishMessage('alpha', 'first');
      await publishMessage('alpha', 'second');

      const stream = lines(await open('alpha', `?since=${first.timestamp}`));
      await publish('alpha', 'live');

      expect((await stream.next()).message).toBe('first');
      expect((await stream.next()).message).toBe('second');
      expect((await stream.next()).message).toBe('live');
    });

    it('replays nothing published before the bound', async () => {
      const old = await publishMessage('alpha', 'older than the bound');

      const stream = lines(await open('alpha', `?since=${old.timestamp + 1}`));
      await publish('alpha', 'published while listening');

      // Had the old message replayed, it would be the first line.
      expect((await stream.next()).message).toBe('published while listening');
    });

    it('replays the whole backlog for ?since=0', async () => {
      await publishMessage('alpha', 'the very first message');

      const stream = lines(await open('alpha', '?since=0'));

      expect((await stream.next()).message).toBe('the very first message');
    });

    it('replays only the topics the client subscribed to', async () => {
      const missed = await publishMessage('alpha', 'from alpha');
      await publishMessage('gamma', 'from gamma');
      await publishMessage('beta', 'from beta');

      const stream = lines(await open('alpha,beta', `?since=${missed.timestamp}`));

      expect((await stream.next()).message).toBe('from alpha');
      expect((await stream.next()).message).toBe('from beta');
    });

    it('carries the same backlog a WebSocket subscriber replays', async () => {
      const missed = await publishMessage('alpha', 'published while offline');

      const stream = lines(await open('alpha', `?since=${missed.timestamp}`));
      const socket = new WebSocket(
        `${httpBase.replace(/^http/, 'ws')}/alpha/ws?since=${missed.timestamp}`,
        { headers: bearer(token) },
      );
      const frame = new Promise<Message>((resolve, reject) => {
        socket.once('message', (data) => resolve(JSON.parse(data.toString()) as Message));
        socket.once('error', reject);
      });

      expect(await stream.next()).toEqual(await frame);
      socket.close();
    });

    it.each(['yesterday', '-1', '1.5', ''])(
      'rejects a stream with since=%j with 400',
      async (since) => {
        const response = await subscribe(`alpha/json?since=${encodeURIComponent(since)}`);

        expect(response.status).toBe(400);
        expect(((await response.json()) as { error: string }).error).toBe(SINCE_RULE);
        expect(broker.listenerCount('alpha')).toBe(0);
      },
    );
  });

  describe('multiplexed over one stream', () => {
    it('writes messages from every topic in the list', async () => {
      const stream = lines(await open('alpha,beta,gamma'));

      await publish('alpha', 'from alpha');
      await publish('beta', 'from beta');
      await publish('gamma', 'from gamma');

      expect((await stream.next()).message).toBe('from alpha');
      expect((await stream.next()).message).toBe('from beta');
      expect((await stream.next()).message).toBe('from gamma');
    });

    it('names the source topic on each line, so a client can tell them apart', async () => {
      const stream = lines(await open('alpha,beta'));

      await publish('beta', 'hello');
      await publish('alpha', 'hello');

      expect((await stream.next()).topic).toBe('beta');
      expect((await stream.next()).topic).toBe('alpha');
    });

    it('attaches exactly one listener to each topic in the list', async () => {
      await open('alpha,beta');

      expect(broker.listenerCount('alpha')).toBe(1);
      expect(broker.listenerCount('beta')).toBe(1);
    });

    it('does not write a topic the client did not ask for', async () => {
      const stream = lines(await open('alpha,beta'));

      // `gamma` fans out first; had it leaked, it would arrive as the first line.
      await publish('gamma', 'not subscribed');
      await publish('beta', 'subscribed');

      expect((await stream.next()).message).toBe('subscribed');
    });

    it('detaches from every topic when the client disconnects', async () => {
      await open('alpha,beta,gamma');

      controllers[controllers.length - 1].abort();

      await vi.waitFor(() => {
        expect(broker.listenerCount('alpha')).toBe(0);
        expect(broker.listenerCount('beta')).toBe(0);
        expect(broker.listenerCount('gamma')).toBe(0);
      });
    });

    it('rejects a list with one bad entry, subscribing to none of it', async () => {
      const response = await subscribe('alpha,bad.topic/json');

      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toMatch(/^topic must be/);
      expect(broker.listenerCount('alpha')).toBe(0);
    });

    it('rejects an over-long list with 400', async () => {
      const names = Array.from({ length: MAX_SUBSCRIBE_TOPICS + 1 }, (_, i) => `topic${i}`);

      const response = await subscribe(`${names.join(',')}/json`);

      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toBe(TOPIC_LIST_RULE);
      expect(broker.listenerCount('topic0')).toBe(0);
    });

    it('serves a list of full-length topic names rather than rejecting the URL', async () => {
      // The router caps a path parameter at 100 characters by default, which is
      // shorter than a legal topic list and answers one with `414` before the route
      // runs. Every name here is at the maximum length, so the whole list is too.
      const names = Array.from({ length: MAX_SUBSCRIBE_TOPICS }, (_, i) =>
        String(i).padStart(MAX_TOPIC_LENGTH, 'a'),
      );

      const response = await open(names.join(','));
      expect(response.status).toBe(200);

      const stream = lines(response);
      await publish(names[MAX_SUBSCRIBE_TOPICS - 1], 'hello');

      expect((await stream.next()).topic).toBe(names[MAX_SUBSCRIBE_TOPICS - 1]);
    });
  });

  it('shuts the server down while a stream is still open', async () => {
    const stream = lines(await open('alpha'));
    await publish('alpha', 'hello');
    expect((await stream.next()).message).toBe('hello');

    // An open stream keeps its connection busy forever, so shutdown has to end it
    // rather than wait for it, and the subscriber has to come off the broker with it.
    await closeApp();

    expect(broker.listenerCount('alpha')).toBe(0);
  });
});

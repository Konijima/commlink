import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { buildApp } from '../src/app';
import { Broker } from '../src/broker';
import type { Message } from '../src/message';

describe('GET /:topic/json', () => {
  let app: FastifyInstance;
  let broker: Broker;
  let httpBase: string;
  let controllers: AbortController[];
  let closed: boolean;

  beforeEach(async () => {
    broker = new Broker();
    app = buildApp({ broker });
    controllers = [];
    closed = false;

    // A real socket on an ephemeral port: `app.inject` buffers the whole response,
    // and streaming it line by line is precisely what these tests are about.
    httpBase = await app.listen({ port: 0, host: '127.0.0.1' });
  });

  afterEach(async () => {
    for (const controller of controllers) controller.abort();
    await closeApp();
  });

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

  /** Open a stream and resolve once it is attached to the topic. */
  async function open(topic: string): Promise<Response> {
    const before = broker.listenerCount(topic);
    const controller = new AbortController();
    controllers.push(controller);

    // Resolves as soon as the headers are flushed; the body arrives line by line.
    const response = await fetch(`${httpBase}/${topic}/json`, { signal: controller.signal });

    await vi.waitFor(() => expect(broker.listenerCount(topic)).toBeGreaterThan(before));

    return response;
  }

  function publish(topic: string, body: string, headers: Record<string, string> = {}) {
    return fetch(`${httpBase}/${topic}`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', ...headers },
      body,
    });
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
    const socket = new WebSocket(`${httpBase.replace(/^http/, 'ws')}/alpha/ws`);
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
      const response = await fetch(`${httpBase}/${encodeURIComponent(topic)}/json`);

      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toMatch(/^topic must be/);
      expect(broker.listenerCount(topic)).toBe(0);
    },
  );

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

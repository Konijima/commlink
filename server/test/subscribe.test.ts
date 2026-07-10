import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import { Broker } from '../src/broker.js';
import { MAX_SUBSCRIBE_TOPICS, SINCE_RULE, TOPIC_LIST_RULE } from '../src/message.js';
import type { Message } from '../src/message.js';
import type { TokenStore } from '../src/tokens.js';
import { bearer, buildTestApp } from './helpers.js';

describe('GET /:topic/ws', () => {
  let app: FastifyInstance;
  let broker: Broker;
  let httpBase: string;
  let wsBase: string;
  let sockets: WebSocket[];
  let tokens: TokenStore;
  let token: string;

  beforeEach(async () => {
    broker = new Broker();
    ({ app, tokens, token } = buildTestApp({ broker }));
    sockets = [];

    // A real socket on an ephemeral port: `app.inject` cannot perform an upgrade,
    // and the handshake is precisely what these tests are about.
    httpBase = await app.listen({ port: 0, host: '127.0.0.1' });
    wsBase = httpBase.replace(/^http/, 'ws');
  });

  afterEach(async () => {
    for (const socket of sockets) socket.close();
    await app.close();
    tokens.close();
  });

  /** Open a subscriber socket, authenticated the way a WebSocket client has to be. */
  function open(path: string): WebSocket {
    const socket = new WebSocket(`${wsBase}/${path}`, { headers: bearer(token) });
    sockets.push(socket);
    return socket;
  }

  /**
   * Open a subscriber on one topic, or on a comma-separated list of them, and resolve
   * once it is attached.
   */
  async function connect(topicList: string): Promise<WebSocket> {
    // One `broker.subscribe` call attaches the listener to every topic at once, so
    // seeing it on the first proves it landed on all of them.
    const [first] = topicList.split(',');
    const before = broker.listenerCount(first);
    const socket = open(`${topicList}/ws`);

    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });

    // The handshake completes before the route handler subscribes, so wait for the
    // listener to be attached rather than racing the first publish against it.
    await vi.waitFor(() => expect(broker.listenerCount(first)).toBeGreaterThan(before));

    return socket;
  }

  /**
   * Start listening for the next frame *before* publishing — an already-open socket
   * drops messages that arrive with no `message` listener attached.
   */
  function nextFrame(socket: WebSocket): Promise<Message> {
    return new Promise((resolve, reject) => {
      socket.once('message', (data) => resolve(JSON.parse(data.toString()) as Message));
      socket.once('error', reject);
    });
  }

  /** Collect the next `count` frames, in the order they arrive. */
  function nextFrames(socket: WebSocket, count: number): Promise<Message[]> {
    return new Promise((resolve, reject) => {
      const frames: Message[] = [];
      socket.on('message', (data) => {
        frames.push(JSON.parse(data.toString()) as Message);
        if (frames.length === count) resolve(frames);
      });
      socket.once('error', reject);
    });
  }

  function closeEvent(socket: WebSocket): Promise<{ code: number; reason: string }> {
    return new Promise((resolve) => {
      socket.once('close', (code, reason) =>
        resolve({ code, reason: reason.toString() }),
      );
    });
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

  /**
   * Open a subscriber that collects frames from the moment the socket exists, and
   * resolve once it is attached to the broker.
   *
   * Replayed frames are written the instant the route attaches its listener, so a
   * `message` handler added after the connection settles would race them. This one
   * cannot: it is attached before the socket can have received anything at all.
   */
  async function collect(
    path: string,
  ): Promise<{ socket: WebSocket; take: (count: number) => Promise<Message[]> }> {
    // `path` is `<topics>/ws?<query>`; the first topic is what proves the attach.
    const [first] = path.split('/')[0].split(',');
    const before = broker.listenerCount(first);

    const socket = open(path);

    const frames: Message[] = [];
    socket.on('message', (data) => frames.push(JSON.parse(data.toString()) as Message));

    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    await vi.waitFor(() => expect(broker.listenerCount(first)).toBeGreaterThan(before));

    return {
      socket,
      take: (count) =>
        vi.waitFor(() => {
          expect(frames.length).toBeGreaterThanOrEqual(count);
          return frames.slice(0, count);
        }),
    };
  }

  it('pushes a published message to a live subscriber', async () => {
    const socket = await connect('alpha');
    const frame = nextFrame(socket);

    const res = await publish('alpha', 'hello', {
      'x-title': 'Deploy finished',
      'x-priority': '5',
      'x-tags': 'ci,deploy',
    });

    expect(res.status).toBe(200);
    expect(await frame).toEqual(await res.json());
  });

  it('sends one JSON frame carrying exactly the documented fields', async () => {
    const socket = await connect('alpha');
    const frame = nextFrame(socket);

    await publish('alpha', 'hello');

    const message = await frame;
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

  it('fans one message out to every subscriber of the topic', async () => {
    // Sequentially, so each `connect` can observe its own listener being attached.
    const first = await connect('alpha');
    const second = await connect('alpha');
    expect(broker.listenerCount('alpha')).toBe(2);

    const frames = Promise.all([nextFrame(first), nextFrame(second)]);
    await publish('alpha', 'hello');

    const [a, b] = await frames;
    expect(a).toEqual(b);
    expect(a.message).toBe('hello');
  });

  it('does not deliver messages published to another topic', async () => {
    const socket = await connect('alpha');
    const frame = nextFrame(socket);

    // `beta` fans out first; had it leaked, it would arrive as the first frame.
    await publish('beta', 'wrong topic');
    await publish('alpha', 'right topic');

    expect((await frame).message).toBe('right topic');
  });

  it('does not replay messages published before the socket connected', async () => {
    await publish('alpha', 'published while nobody listened');

    const socket = await connect('alpha');
    const frame = nextFrame(socket);
    await publish('alpha', 'published while listening');

    expect((await frame).message).toBe('published while listening');
  });

  it('sends no frame for a publish the server rejected', async () => {
    const socket = await connect('alpha');
    const frame = nextFrame(socket);

    const rejected = await publish('alpha', 'hello', { 'x-priority': '9' });
    expect(rejected.status).toBe(400);
    await publish('alpha', 'accepted');

    expect((await frame).message).toBe('accepted');
  });

  it('detaches the subscriber when the socket closes', async () => {
    const socket = await connect('alpha');

    socket.close();

    await vi.waitFor(() => expect(broker.listenerCount('alpha')).toBe(0));
  });

  it('detaches the subscriber when the socket dies without a close frame', async () => {
    const socket = await connect('alpha');

    socket.terminate();

    await vi.waitFor(() => expect(broker.listenerCount('alpha')).toBe(0));
  });

  it.each(['bad.topic', 'bad topic', 'a'.repeat(65), 'healthz'])(
    'closes a subscription to invalid topic %j with 1008',
    async (topic) => {
      const socket = open(`${encodeURIComponent(topic)}/ws`);

      const { code, reason } = await closeEvent(socket);

      expect(code).toBe(1008);
      expect(reason).toMatch(/^topic must be/);
      expect(broker.listenerCount(topic)).toBe(0);
    },
  );

  describe('?since= replay', () => {
    it('replays a message published before the socket connected', async () => {
      const missed = await publishMessage('alpha', 'published while offline');

      const { take } = await collect(`alpha/ws?since=${missed.timestamp}`);

      expect(await take(1)).toEqual([missed]);
    });

    it('replays the backlog in publication order', async () => {
      const first = await publishMessage('alpha', 'first');
      await publishMessage('alpha', 'second');
      await publishMessage('alpha', 'third');

      const { take } = await collect(`alpha/ws?since=${first.timestamp}`);

      expect((await take(3)).map((frame) => frame.message)).toEqual([
        'first',
        'second',
        'third',
      ]);
    });

    it('streams live messages after the replayed ones', async () => {
      const missed = await publishMessage('alpha', 'published while offline');

      const { take } = await collect(`alpha/ws?since=${missed.timestamp}`);
      await publish('alpha', 'published while listening');

      expect((await take(2)).map((frame) => frame.message)).toEqual([
        'published while offline',
        'published while listening',
      ]);
    });

    it('replays a message published in the same second as the bound', async () => {
      // Timestamps resolve to the second, so the bound is inclusive: a client asking
      // for everything since the last message it saw must not lose one published
      // during that same second. The cost is a duplicate, which clients drop by `id`.
      const missed = await publishMessage('alpha', 'same second as the bound');

      const { take } = await collect(`alpha/ws?since=${missed.timestamp}`);

      expect(await take(1)).toEqual([missed]);
    });

    it('replays nothing published before the bound', async () => {
      const old = await publishMessage('alpha', 'older than the bound');

      const { take } = await collect(`alpha/ws?since=${old.timestamp + 1}`);
      await publish('alpha', 'published while listening');

      // Had the old message replayed, it would be the first frame.
      expect((await take(1)).map((frame) => frame.message)).toEqual([
        'published while listening',
      ]);
    });

    it('replays the whole backlog for ?since=0', async () => {
      await publishMessage('alpha', 'the very first message');

      const { take } = await collect('alpha/ws?since=0');

      expect((await take(1)).map((frame) => frame.message)).toEqual([
        'the very first message',
      ]);
    });

    it('replays only the topics the client subscribed to', async () => {
      const missed = await publishMessage('alpha', 'from alpha');
      await publishMessage('gamma', 'from gamma');
      await publishMessage('beta', 'from beta');

      const { take } = await collect(`alpha,beta/ws?since=${missed.timestamp}`);

      expect((await take(2)).map((frame) => frame.message)).toEqual([
        'from alpha',
        'from beta',
      ]);
    });

    it('replays nothing when the topic has no stored messages', async () => {
      const { socket, take } = await collect('alpha/ws?since=0');
      await publish('alpha', 'the only message');

      expect((await take(1)).map((frame) => frame.message)).toEqual(['the only message']);
      expect(socket.readyState).toBe(socket.OPEN);
    });

    it.each(['yesterday', '-1', '1.5', ''])(
      'closes a subscription with since=%j with 1008',
      async (since) => {
        const socket = open(`alpha/ws?since=${encodeURIComponent(since)}`);

        const { code, reason } = await closeEvent(socket);

        expect(code).toBe(1008);
        expect(reason).toBe(SINCE_RULE);
        expect(broker.listenerCount('alpha')).toBe(0);
      },
    );
  });

  describe('multiplexed over one connection', () => {
    it('delivers messages from every topic in the list', async () => {
      const socket = await connect('alpha,beta,gamma');
      const frames = nextFrames(socket, 3);

      await publish('alpha', 'from alpha');
      await publish('beta', 'from beta');
      await publish('gamma', 'from gamma');

      expect((await frames).map((frame) => frame.message)).toEqual([
        'from alpha',
        'from beta',
        'from gamma',
      ]);
    });

    it('names the source topic on each frame, so a client can tell them apart', async () => {
      const socket = await connect('alpha,beta');
      const frames = nextFrames(socket, 2);

      await publish('beta', 'hello');
      await publish('alpha', 'hello');

      expect((await frames).map((frame) => frame.topic)).toEqual(['beta', 'alpha']);
    });

    it('attaches exactly one listener to each topic in the list', async () => {
      await connect('alpha,beta');

      expect(broker.listenerCount('alpha')).toBe(1);
      expect(broker.listenerCount('beta')).toBe(1);
    });

    it('delivers one frame per message when a topic is listed twice', async () => {
      const socket = await connect('alpha,alpha');
      expect(broker.listenerCount('alpha')).toBe(1);

      const frames = nextFrames(socket, 2);
      await publish('alpha', 'first');
      await publish('alpha', 'second');

      expect((await frames).map((frame) => frame.message)).toEqual(['first', 'second']);
    });

    it('does not deliver a topic the client did not ask for', async () => {
      const socket = await connect('alpha,beta');
      const frame = nextFrame(socket);

      // `gamma` fans out first; had it leaked, it would arrive as the first frame.
      await publish('gamma', 'not subscribed');
      await publish('beta', 'subscribed');

      expect((await frame).message).toBe('subscribed');
    });

    it('detaches from every topic when the socket closes', async () => {
      const socket = await connect('alpha,beta,gamma');

      socket.close();

      await vi.waitFor(() => {
        expect(broker.listenerCount('alpha')).toBe(0);
        expect(broker.listenerCount('beta')).toBe(0);
        expect(broker.listenerCount('gamma')).toBe(0);
      });
    });

    it('closes a list with one bad entry with 1008, subscribing to none of it', async () => {
      const socket = open('alpha,bad.topic/ws');

      const { code, reason } = await closeEvent(socket);

      expect(code).toBe(1008);
      expect(reason).toMatch(/^topic must be/);
      expect(broker.listenerCount('alpha')).toBe(0);
    });

    it('closes an over-long list with 1008', async () => {
      const names = Array.from(
        { length: MAX_SUBSCRIBE_TOPICS + 1 },
        (_, i) => `topic${i}`,
      );
      const socket = open(`${names.join(',')}/ws`);

      const { code, reason } = await closeEvent(socket);

      expect(code).toBe(1008);
      expect(reason).toBe(TOPIC_LIST_RULE);
      expect(broker.listenerCount('topic0')).toBe(0);
    });

    it('accepts a list exactly at the limit', async () => {
      const names = Array.from({ length: MAX_SUBSCRIBE_TOPICS }, (_, i) => `topic${i}`);
      const socket = await connect(names.join(','));

      const frame = nextFrame(socket);
      await publish('topic49', 'hello');

      expect((await frame).topic).toBe('topic49');
    });
  });

  it('still serves the health probe alongside the subscribe route', async () => {
    const res = await fetch(`${httpBase}/healthz`);

    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('ok');
  });
});

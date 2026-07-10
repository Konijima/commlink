import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Broker } from '../src/broker.js';
import { type Message, reservedTopicRule } from '../src/message.js';
import { MessageStore } from '../src/store.js';
import type { TokenStore } from '../src/tokens.js';
import { bearer, buildTestApp } from './helpers.js';

describe('POST /:topic', () => {
  let app: FastifyInstance;
  let broker: Broker;
  let store: MessageStore;
  let tokens: TokenStore;
  let token: string;

  beforeEach(async () => {
    broker = new Broker();
    store = new MessageStore();
    ({ app, tokens, token } = buildTestApp({ broker, store }));
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    store.close();
    tokens.close();
  });

  it('accepts a bare text body and echoes the stored message', async () => {
    const before = Math.floor(Date.now() / 1000);

    const res = await app.inject({
      method: 'POST',
      url: '/mytopic',
      headers: { ...bearer(token), 'content-type': 'text/plain' },
      payload: 'hello',
    });

    expect(res.statusCode).toBe(200);

    const body = res.json() as Message;
    expect(body.topic).toBe('mytopic');
    expect(body.message).toBe('hello');
    expect(body.title).toBeNull();
    expect(body.priority).toBe(3);
    expect(body.tags).toEqual([]);
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.timestamp).toBeGreaterThanOrEqual(before);
  });

  it('accepts the content type curl sends for `curl -d hello`', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/mytopic',
      headers: { ...bearer(token), 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'hello',
    });

    expect(res.statusCode).toBe(200);
    expect((res.json() as Message).message).toBe('hello');
  });

  it('accepts a body sent with no content type at all', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/mytopic',
      headers: bearer(token),
      payload: 'hello',
    });

    expect(res.statusCode).toBe(200);
    expect((res.json() as Message).message).toBe('hello');
  });

  it('keeps a JSON body as verbatim text rather than reshaping it', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/mytopic',
      headers: { ...bearer(token), 'content-type': 'application/json' },
      payload: '{"deploy":"done"}',
    });

    expect(res.statusCode).toBe(200);
    expect((res.json() as Message).message).toBe('{"deploy":"done"}');
  });

  it('reads title, priority and tags from headers', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/mytopic',
      headers: {
        ...bearer(token),
        'content-type': 'text/plain',
        'x-title': 'Deploy finished',
        'x-priority': '5',
        'x-tags': 'ci, deploy ,,rocket',
      },
      payload: 'shipped',
    });

    expect(res.statusCode).toBe(200);

    const body = res.json() as Message;
    expect(body.title).toBe('Deploy finished');
    expect(body.priority).toBe(5);
    expect(body.tags).toEqual(['ci', 'deploy', 'rocket']);
  });

  it('treats a blank title as no title', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/mytopic',
      headers: { ...bearer(token), 'content-type': 'text/plain', 'x-title': '   ' },
      payload: 'hello',
    });

    expect(res.statusCode).toBe(200);
    expect((res.json() as Message).title).toBeNull();
  });

  it('delivers the published message to a live subscriber', async () => {
    const listener = vi.fn();
    broker.subscribe(['mytopic'], listener);

    const res = await app.inject({
      method: 'POST',
      url: '/mytopic',
      headers: { ...bearer(token), 'content-type': 'text/plain' },
      payload: 'hello',
    });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[0]).toEqual(res.json());
  });

  it('persists the published message', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/mytopic',
      headers: {
        ...bearer(token),
        'content-type': 'text/plain',
        'x-title': 'Deploy finished',
        'x-priority': '5',
        'x-tags': 'ci,deploy',
      },
      payload: 'shipped',
    });

    expect(res.statusCode).toBe(200);
    expect(store.since(['mytopic'], 0)).toEqual([res.json()]);
  });

  it('persists a message before handing it to live subscribers', async () => {
    // A subscriber that reconnects right after a frame arrives asks to replay from it.
    // Were the message stored afterwards, that replay could come up empty.
    let storedWhenDelivered: Message[] = [];
    broker.subscribe(['mytopic'], () => {
      storedWhenDelivered = store.since(['mytopic'], 0);
    });

    const res = await app.inject({
      method: 'POST',
      url: '/mytopic',
      headers: { ...bearer(token), 'content-type': 'text/plain' },
      payload: 'hello',
    });

    expect(storedWhenDelivered).toEqual([res.json()]);
  });

  it('does not persist a rejected message', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/mytopic',
      headers: { ...bearer(token), 'content-type': 'text/plain', 'x-priority': '9' },
      payload: 'hello',
    });

    expect(res.statusCode).toBe(400);
    expect(store.since(['mytopic'], 0)).toEqual([]);
  });

  it('gives every message a distinct id', async () => {
    const publish = () =>
      app.inject({
        method: 'POST',
        url: '/mytopic',
        headers: { ...bearer(token), 'content-type': 'text/plain' },
        payload: 'hello',
      });

    const [first, second] = await Promise.all([publish(), publish()]);

    expect((first.json() as Message).id).not.toBe((second.json() as Message).id);
  });

  it.each([
    ['an empty body and no title', '', {}],
    ['a whitespace-only title and empty body', '', { 'x-title': ' ' }],
  ])('rejects %s with 400', async (_name, payload, headers) => {
    const res = await app.inject({
      method: 'POST',
      url: '/mytopic',
      headers: { ...bearer(token), 'content-type': 'text/plain', ...headers },
      payload,
    });

    expect(res.statusCode).toBe(400);
  });

  it('accepts an empty body when a title is present', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/mytopic',
      headers: { ...bearer(token), 'content-type': 'text/plain', 'x-title': 'Ping' },
      payload: '',
    });

    expect(res.statusCode).toBe(200);

    const body = res.json() as Message;
    expect(body.title).toBe('Ping');
    expect(body.message).toBe('');
  });

  it.each(['0', '6', '-1', '3.5', 'high', '', ' '])(
    'rejects priority %j with 400',
    async (priority) => {
      const res = await app.inject({
        method: 'POST',
        url: '/mytopic',
        headers: {
          ...bearer(token),
          'content-type': 'text/plain',
          'x-priority': priority,
        },
        payload: 'hello',
      });

      expect(res.statusCode).toBe(400);
    },
  );

  it.each(['1', '2', '3', '4', '5'])('accepts priority %j', async (priority) => {
    const res = await app.inject({
      method: 'POST',
      url: '/mytopic',
      headers: { ...bearer(token), 'content-type': 'text/plain', 'x-priority': priority },
      payload: 'hello',
    });

    expect(res.statusCode).toBe(200);
    expect((res.json() as Message).priority).toBe(Number(priority));
  });

  it.each(['bad topic', 'bad/topic', 'bad.topic', 'a'.repeat(65)])(
    'rejects topic %j with 400',
    async (topic) => {
      const res = await app.inject({
        method: 'POST',
        url: `/${encodeURIComponent(topic)}`,
        headers: { ...bearer(token), 'content-type': 'text/plain' },
        payload: 'hello',
      });

      expect(res.statusCode).toBe(400);
    },
  );

  it('refuses a publish to a reserved name by naming it, not the alphabet', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/healthz',
      headers: { ...bearer(token), 'content-type': 'text/plain' },
      payload: 'hello',
    });

    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe(reservedTopicRule('healthz'));
  });

  it('does not publish a rejected message to subscribers', async () => {
    const listener = vi.fn();
    broker.subscribe(['mytopic'], listener);

    const res = await app.inject({
      method: 'POST',
      url: '/mytopic',
      headers: { ...bearer(token), 'content-type': 'text/plain', 'x-priority': '9' },
      payload: 'hello',
    });

    expect(res.statusCode).toBe(400);
    expect(listener).not.toHaveBeenCalled();
  });

  it('still serves the health probe alongside the topic route', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });

    expect(res.statusCode).toBe(200);
    expect((res.json() as { status: string }).status).toBe('ok');
  });
});

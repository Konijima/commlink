import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Broker } from '../src/broker.js';
import { MAX_BODY_BYTES, bodyRule } from '../src/message.js';
import { MessageStore } from '../src/store.js';
import type { TokenStore } from '../src/tokens.js';
import { bearer, buildTestApp } from './helpers.js';

/** A body of exactly `bytes` bytes, one ASCII character each. */
const body = (bytes: number): string => 'x'.repeat(bytes);

describe('publish body limit', () => {
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

  const publish = (payload: string, headers: Record<string, string> = bearer(token)) =>
    app.inject({ method: 'POST', url: '/mytopic', headers, payload });

  it('accepts a body of exactly the limit', async () => {
    const res = await publish(body(MAX_BODY_BYTES));

    expect(res.statusCode).toBe(200);
    expect((res.json() as { message: string }).message).toHaveLength(MAX_BODY_BYTES);
  });

  it('rejects one byte more with 413', async () => {
    const res = await publish(body(MAX_BODY_BYTES + 1));

    expect(res.statusCode).toBe(413);
    // Nothing is passed to `buildApp`, so the shipped 4 KB default is the one enforced.
    expect(res.json()).toEqual({ error: bodyRule() });
    expect(bodyRule()).toContain('4096');
  });

  it('measures bytes, not characters', async () => {
    // Half as many characters as the limit allows, but two bytes each: over it.
    const payload = 'é'.repeat(MAX_BODY_BYTES / 2 + 1);

    expect(payload.length).toBeLessThan(MAX_BODY_BYTES);
    expect(Buffer.byteLength(payload)).toBeGreaterThan(MAX_BODY_BYTES);
    expect((await publish(payload)).statusCode).toBe(413);
  });

  it('neither stores nor delivers an over-long message', async () => {
    const listener = vi.fn();
    broker.subscribe(['mytopic'], listener);

    expect((await publish(body(MAX_BODY_BYTES + 1))).statusCode).toBe(413);
    expect(listener).not.toHaveBeenCalled();
    expect(store.since(['mytopic'], 0)).toEqual([]);
  });

  it('refuses an over-long body before reading the token', async () => {
    // The whole point of the limit: an anonymous client is turned away by the body it
    // sent, not by the token it lacks — so the server never holds the body to find out.
    const res = await publish(body(MAX_BODY_BYTES + 1), {});

    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({ error: bodyRule() });
  });

  it('leaves a small body to the token check', async () => {
    // The converse, so the test above is pinning the order and not merely a 413.
    const res = await publish('hello', {});

    expect(res.statusCode).toBe(401);
  });

  it('does not charge an over-long publish to the rate limit', async () => {
    // It is refused before the limiter's hook runs, which is consistent with the rule
    // that only an authenticated request spends a token's budget.
    const limited = buildTestApp({ publishRateLimit: 1 });
    await limited.app.ready();

    const over = await limited.app.inject({
      method: 'POST',
      url: '/mytopic',
      headers: bearer(limited.token),
      payload: body(MAX_BODY_BYTES + 1),
    });
    expect(over.statusCode).toBe(413);

    // The one slot the token has is still unspent.
    const first = await limited.app.inject({
      method: 'POST',
      url: '/mytopic',
      headers: bearer(limited.token),
      payload: 'hello',
    });
    expect(first.statusCode).toBe(200);

    await limited.app.close();
    limited.tokens.close();
  });

  it('honours an injected limit, and names it in the refusal', async () => {
    const tight = buildTestApp({ maxBodyBytes: 8 });
    await tight.app.ready();

    const publishTo = (payload: string) =>
      tight.app.inject({
        method: 'POST',
        url: '/mytopic',
        headers: bearer(tight.token),
        payload,
      });

    expect((await publishTo(body(8))).statusCode).toBe(200);

    const over = await publishTo(body(9));
    expect(over.statusCode).toBe(413);
    expect(over.json()).toEqual({ error: bodyRule(8) });

    await tight.app.close();
    tight.tokens.close();
  });

  it('still reports an over-long body when the topic is also invalid', async () => {
    // Body parsing precedes routing's own checks; the client hears about the body.
    const res = await app.inject({
      method: 'POST',
      url: '/bad.topic',
      headers: bearer(token),
      payload: body(MAX_BODY_BYTES + 1),
    });

    expect(res.statusCode).toBe(413);
  });
});

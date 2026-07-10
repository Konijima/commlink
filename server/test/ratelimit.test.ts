import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { Broker } from '../src/broker.js';
import {
  PUBLISH_RATE_LIMIT,
  RATE_LIMIT_CONFIG_RULE,
  RATE_LIMIT_RULE,
  RATE_LIMIT_WINDOW_MS,
  RateLimiter,
  publishRateLimit,
} from '../src/ratelimit.js';
import { TokenStore } from '../src/tokens.js';
import { bearer } from './helpers.js';

describe('RateLimiter', () => {
  /** A token id; the limiter only ever compares them. */
  const KEY = 1;
  const OTHER_KEY = 2;

  /** A window of whole seconds keeps the expected `Retry-After` easy to state. */
  const WINDOW_MS = 10_000;

  it('allows requests up to the limit', () => {
    const limiter = new RateLimiter(3, WINDOW_MS);

    expect([limiter.take(KEY, 0), limiter.take(KEY, 1), limiter.take(KEY, 2)]).toEqual([
      null,
      null,
      null,
    ]);
  });

  it('refuses the request past the limit', () => {
    const limiter = new RateLimiter(2, WINDOW_MS);
    limiter.take(KEY, 0);
    limiter.take(KEY, 0);

    expect(limiter.take(KEY, 0)).not.toBeNull();
  });

  it('says how long until the oldest request leaves the window', () => {
    const limiter = new RateLimiter(1, WINDOW_MS);
    limiter.take(KEY, 0);

    // The one recorded hit leaves the window at 10 000ms; 4s in, that is 6s away.
    expect(limiter.take(KEY, 4_000)).toBe(6);
  });

  it('never says to retry after zero seconds, which would invite an instant retry', () => {
    const limiter = new RateLimiter(1, WINDOW_MS);
    limiter.take(KEY, 0);

    // 1ms of the window is left. Rounded down that is "now"; the caller must wait.
    expect(limiter.take(KEY, WINDOW_MS - 1)).toBe(1);
  });

  it('does not charge a refused request, so retrying does not push the slot away', () => {
    const limiter = new RateLimiter(1, WINDOW_MS);
    limiter.take(KEY, 0);

    expect(limiter.take(KEY, 1_000)).toBe(9);
    // Had the refusal been recorded, the wait would now be measured from 2 000ms.
    expect(limiter.take(KEY, 2_000)).toBe(8);
  });

  it('frees the slot once the oldest request leaves the window', () => {
    const limiter = new RateLimiter(1, WINDOW_MS);
    limiter.take(KEY, 0);

    expect(limiter.take(KEY, WINDOW_MS)).toBeNull();
  });

  it('slides the window rather than resetting it on a boundary', () => {
    const limiter = new RateLimiter(2, WINDOW_MS);
    // Both slots spent at the end of one nominal window...
    limiter.take(KEY, 9_000);
    limiter.take(KEY, 9_500);

    // ...leave none to spend at the start of the next. A fixed window would allow
    // four requests across these 1 500ms; a sliding one allows two.
    expect(limiter.take(KEY, 10_000)).not.toBeNull();
    expect(limiter.take(KEY, 10_500)).not.toBeNull();
    // The first hit leaves the window at 19 000ms, and only then does a slot free.
    expect(limiter.take(KEY, 19_000)).toBeNull();
  });

  it('counts each key against its own budget', () => {
    const limiter = new RateLimiter(1, WINDOW_MS);
    limiter.take(KEY, 0);

    expect(limiter.take(OTHER_KEY, 0)).toBeNull();
    expect(limiter.take(KEY, 0)).not.toBeNull();
  });

  it('holds no more than `limit` timestamps for a key that keeps being refused', () => {
    const limiter = new RateLimiter(1, WINDOW_MS);
    for (let at = 0; at < 100; at += 1) limiter.take(KEY, at);

    // Only the single allowed hit was recorded, so it is still the one that expires,
    // 10 000ms after it happened rather than after the last refusal.
    expect(limiter.take(KEY, WINDOW_MS)).toBeNull();
  });

  it.each([
    ['a limit of zero', 0, WINDOW_MS],
    ['a negative limit', -1, WINDOW_MS],
    ['a fractional limit', 1.5, WINDOW_MS],
    ['a window of zero', 1, 0],
    ['a negative window', 1, -1],
    ['a fractional window', 1, 1.5],
  ])('refuses to be built with %s', (_name, limit, windowMs) => {
    expect(() => new RateLimiter(limit, windowMs)).toThrow(RangeError);
    expect(() => new RateLimiter(limit, windowMs)).toThrow(RATE_LIMIT_CONFIG_RULE);
  });

  it('defaults to 60 requests a minute', () => {
    expect(PUBLISH_RATE_LIMIT).toBe(60);
    expect(RATE_LIMIT_WINDOW_MS).toBe(60_000);

    const limiter = new RateLimiter();
    for (let n = 0; n < PUBLISH_RATE_LIMIT; n += 1) expect(limiter.take(KEY, 0)).toBeNull();

    expect(limiter.take(KEY, 0)).toBe(60);
  });
});

describe('publishRateLimit', () => {
  it('fails loudly when it runs before the request was authenticated', async () => {
    const limiter = new RateLimiter();
    const hook = publishRateLimit(limiter);
    // No `preValidation` ran, so nothing named a token to charge.
    const request = { tokenId: undefined } as FastifyRequest;
    const reply = {} as FastifyReply;

    await expect(hook(request, reply)).rejects.toThrow(/before the request was authenticated/);
  });

  it('spends a slot of the token that authenticated, not of some shared budget', async () => {
    const limiter = new RateLimiter(1, 10_000);
    const hook = publishRateLimit(limiter);
    // A request within budget is let through untouched, so the reply is never used.
    const reply = {} as FastifyReply;
    const requestFor = (tokenId: number) => ({ tokenId }) as FastifyRequest;

    // One token spends its only slot; a different token still has its own.
    await hook(requestFor(1), reply);
    expect(limiter.take(1)).not.toBeNull();
    expect(limiter.take(2)).toBeNull();
  });
});

describe('POST /:topic rate limit', () => {
  /** Two publishes each, so the third is the one that is refused. */
  const LIMIT = 2;

  let app: FastifyInstance;
  let broker: Broker;
  let tokens: TokenStore;
  let token: string;
  let otherToken: string;

  beforeEach(async () => {
    broker = new Broker();
    tokens = new TokenStore();
    token = tokens.create('publisher');
    otherToken = tokens.create('other');
    app = buildApp({ broker, tokens, publishRateLimit: LIMIT });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    tokens.close();
  });

  const publish = (as: string, url = '/mytopic') =>
    app.inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'text/plain', ...bearer(as) },
      payload: 'hello',
    });

  /** Spend `token`'s whole budget, and assert every publish was accepted. */
  async function exhaust(as: string = token): Promise<void> {
    for (let n = 0; n < LIMIT; n += 1) expect((await publish(as)).statusCode).toBe(200);
  }

  it('accepts publishes up to the limit', async () => {
    await exhaust();
  });

  it('answers the publish past the limit with 429', async () => {
    await exhaust();
    const res = await publish(token);

    expect(res.statusCode).toBe(429);
    expect((res.json() as { error: string }).error).toBe(RATE_LIMIT_RULE);
  });

  it('tells a limited client when to retry', async () => {
    await exhaust();
    const retryAfter = Number((await publish(token)).headers['retry-after']);

    // The window is a minute, and the budget was spent just now.
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(RATE_LIMIT_WINDOW_MS / 1000);
  });

  it('refuses a limited publish before it reaches a subscriber', async () => {
    let delivered = 0;
    broker.subscribe(['mytopic'], () => (delivered += 1));

    await exhaust();
    expect((await publish(token)).statusCode).toBe(429);
    expect(delivered).toBe(LIMIT);
  });

  it('counts each token against its own budget', async () => {
    await exhaust(token);
    expect((await publish(token)).statusCode).toBe(429);

    // A publisher that has been quiet is not punished for a noisy one.
    await exhaust(otherToken);
  });

  it('counts a publish the handler rejects, which is the flood worth stopping', async () => {
    // An invalid topic is a `400`, but it cost a slot on the way to being refused.
    expect((await publish(token, '/bad.topic')).statusCode).toBe(400);
    expect((await publish(token)).statusCode).toBe(200);

    expect((await publish(token)).statusCode).toBe(429);
  });

  it('does not count a publish that failed to authenticate', async () => {
    const unissued = await app.inject({
      method: 'POST',
      url: '/mytopic',
      headers: { 'content-type': 'text/plain', ...bearer('x'.repeat(43)) },
      payload: 'hello',
    });

    // Auth runs first, so an unauthorized publish spends nobody's budget — least of
    // all that of the token whose name it never carried.
    expect(unissued.statusCode).toBe(401);
    await exhaust();
  });

  it('hands a token minted to replace a revoked one a fresh budget', async () => {
    // `other` is the newest token, so its id is the one SQLite would hand out again if
    // the column were not `AUTOINCREMENT` — and the budget is keyed by id. An operator
    // who replaces a token must not also hand over what the revoked one had spent.
    await exhaust(otherToken);
    expect((await publish(otherToken)).statusCode).toBe(429);

    expect(tokens.revoke('other')).toBe(true);
    const replacement = tokens.create('other');

    await exhaust(replacement);
  });

  it('does not limit the health probe, which carries no token to charge', async () => {
    for (let n = 0; n < LIMIT + 1; n += 1) {
      expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    }
  });

  it('does not limit subscribing', async () => {
    await exhaust();

    // The cap is on publishing. A subscriber holds one connection open for hours and
    // would otherwise be refused the reconnect it needs most. A real socket, because
    // `app.inject` waits for a response body that a live stream never ends.
    const base = await app.listen({ port: 0, host: '127.0.0.1' });
    const controller = new AbortController();
    try {
      const res = await fetch(`${base}/mytopic/json`, {
        headers: bearer(token),
        signal: controller.signal,
      });

      expect(res.status).toBe(200);
    } finally {
      controller.abort();
    }
  });
});

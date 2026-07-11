import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Broker } from '../src/broker.js';
import {
  MAX_PRIORITY,
  MAX_TAGS,
  MAX_TAG_BYTES,
  MAX_TITLE_BYTES,
  MIN_PRIORITY,
  PRIORITY_RULE,
  TAGS_RULE,
  TITLE_RULE,
  type Message,
  parsePriority,
  parseTags,
  parseTitle,
} from '../src/message.js';
import { MessageStore } from '../src/store.js';
import type { TokenStore } from '../src/tokens.js';
import { bearer, buildTestApp } from './helpers.js';

/** A value of exactly `bytes` bytes, one ASCII character each. */
const ascii = (bytes: number): string => 'x'.repeat(bytes);

/**
 * A UTF-8 string as Node hands it to a route: header values are decoded latin1, one
 * character per byte received, so this is what `'é'.repeat(n)` looks like on arrival.
 * `app.inject` skips the wire, and would otherwise deliver characters Node never would.
 */
const asReceived = (value: string): string =>
  Buffer.from(value, 'utf8').toString('latin1');

describe('parseTitle', () => {
  it('accepts a title of exactly the limit', () => {
    expect(parseTitle(ascii(MAX_TITLE_BYTES))).toHaveLength(MAX_TITLE_BYTES);
  });

  it('rejects one byte more', () => {
    expect(() => parseTitle(ascii(MAX_TITLE_BYTES + 1))).toThrow(TITLE_RULE);
  });

  it('counts the bytes received, not the characters they spell', () => {
    // Half as many characters as the limit allows, at two bytes each: over it.
    const title = asReceived('é'.repeat(MAX_TITLE_BYTES / 2 + 1));

    expect(title.length).toBeGreaterThan(MAX_TITLE_BYTES);
    expect(() => parseTitle(title)).toThrow(TITLE_RULE);
  });

  it('admits a two-byte character that fits', () => {
    const title = asReceived('é'.repeat(MAX_TITLE_BYTES / 2));

    expect(() => parseTitle(title)).not.toThrow();
  });

  it('bounds the title as sent, so padding does not buy room', () => {
    // It would trim down to two characters, but the client still sent the space.
    expect(() => parseTitle(`${' '.repeat(MAX_TITLE_BYTES)}hi`)).toThrow(TITLE_RULE);
  });

  it('still reads a blank title as no title', () => {
    expect(parseTitle('   ')).toBeNull();
  });
});

describe('parseTags', () => {
  const tags = (count: number): string =>
    Array.from({ length: count }, () => 'a').join(',');

  it('accepts exactly the tag limit', () => {
    expect(parseTags(tags(MAX_TAGS))).toHaveLength(MAX_TAGS);
  });

  it('rejects one tag more', () => {
    expect(() => parseTags(tags(MAX_TAGS + 1))).toThrow(TAGS_RULE);
  });

  it('accepts a tag of exactly the per-tag limit', () => {
    expect(parseTags(ascii(MAX_TAG_BYTES))).toEqual([ascii(MAX_TAG_BYTES)]);
  });

  it('rejects a tag one byte longer', () => {
    expect(() => parseTags(`ok,${ascii(MAX_TAG_BYTES + 1)}`)).toThrow(TAGS_RULE);
  });

  it('counts a tag in the bytes received, not the characters they spell', () => {
    expect(() => parseTags(asReceived('é'.repeat(MAX_TAG_BYTES / 2 + 1)))).toThrow(
      TAGS_RULE,
    );
  });

  it('counts a tag after its surrounding space is trimmed', () => {
    // What is bounded is the tag a subscriber is sent, which is the trimmed one.
    expect(parseTags(`   ${ascii(MAX_TAG_BYTES)}   `)).toEqual([ascii(MAX_TAG_BYTES)]);
  });

  it('counts tags after the empty ones are dropped', () => {
    // `MAX_TAGS + 1` separators, but one names nothing, so the message carries `MAX_TAGS`.
    expect(parseTags(`,${tags(MAX_TAGS)}`)).toHaveLength(MAX_TAGS);
  });
});

describe('parsePriority', () => {
  it('accepts each value in range', () => {
    for (let value = MIN_PRIORITY; value <= MAX_PRIORITY; value++) {
      expect(parsePriority(String(value))).toBe(value);
    }
  });

  it.each(['0', '6', '-1', '3.5', 'high', '', ' '])(
    'rejects %j naming the header',
    (value) => {
      // Like `TITLE_RULE` and `TAGS_RULE`, the refusal names the header the client set
      // so a `400` read off `error` says which one to fix.
      expect(() => parsePriority(value)).toThrow(PRIORITY_RULE);
      expect(PRIORITY_RULE).toContain('X-Priority');
    },
  );
});

describe('publish header limits', () => {
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

  const publish = (headers: Record<string, string>) =>
    app.inject({
      method: 'POST',
      url: '/mytopic',
      headers: { ...bearer(token), ...headers },
      payload: 'hello',
    });

  it('accepts a title and tags at exactly their limits', async () => {
    const res = await publish({
      'x-title': ascii(MAX_TITLE_BYTES),
      'x-tags': Array.from({ length: MAX_TAGS }, () => ascii(MAX_TAG_BYTES)).join(','),
    });

    expect(res.statusCode).toBe(200);
    const message = res.json() as Message;
    expect(message.title).toHaveLength(MAX_TITLE_BYTES);
    expect(message.tags).toHaveLength(MAX_TAGS);
  });

  it('refuses an over-long title with 400, naming the rule', async () => {
    const res = await publish({ 'x-title': ascii(MAX_TITLE_BYTES + 1) });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: TITLE_RULE });
    expect(TITLE_RULE).toContain('256');
  });

  it('refuses too many tags with 400, naming the rule', async () => {
    const res = await publish({
      'x-tags': Array.from({ length: MAX_TAGS + 1 }, () => 'a').join(','),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: TAGS_RULE });
  });

  it('refuses an over-long tag with 400', async () => {
    const res = await publish({ 'x-tags': ascii(MAX_TAG_BYTES + 1) });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: TAGS_RULE });
  });

  it('neither stores nor delivers a message with an over-long title', async () => {
    const listener = vi.fn();
    broker.subscribe(['mytopic'], listener);

    expect((await publish({ 'x-title': ascii(MAX_TITLE_BYTES + 1) })).statusCode).toBe(
      400,
    );
    expect(listener).not.toHaveBeenCalled();
    expect(store.since(['mytopic'], 0)).toEqual([]);
  });

  it('refuses a bad priority with 400, naming the header', async () => {
    const res = await publish({ 'x-priority': '9' });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: PRIORITY_RULE });
    expect(PRIORITY_RULE).toContain('X-Priority');
  });

  it('reports the broken priority when the title is over-long too', async () => {
    // Priority is parsed first, and one refusal names one rule.
    const res = await publish({
      'x-priority': '9',
      'x-title': ascii(MAX_TITLE_BYTES + 1),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: PRIORITY_RULE });
  });

  it('leaves an over-long title to the token check', async () => {
    // Auth is a `preValidation` hook, so it runs before the handler reads a header:
    // an anonymous client hears about the token it lacks, not the title it sent.
    const res = await app.inject({
      method: 'POST',
      url: '/mytopic',
      headers: { 'x-title': ascii(MAX_TITLE_BYTES + 1) },
      payload: 'hello',
    });

    expect(res.statusCode).toBe(401);
  });

  it('charges an over-long title to the rate limit', async () => {
    // The limiter is a `preHandler`, so it has already spent the slot by the time the
    // header is read — which is the rule: every authenticated attempt costs one, and a
    // client hammering the server with malformed publishes is what the limit is for.
    const limited = buildTestApp({ publishRateLimit: 1 });
    await limited.app.ready();

    const attempt = (headers: Record<string, string>) =>
      limited.app.inject({
        method: 'POST',
        url: '/mytopic',
        headers: { ...bearer(limited.token), ...headers },
        payload: 'hello',
      });

    expect((await attempt({ 'x-title': ascii(MAX_TITLE_BYTES + 1) })).statusCode).toBe(
      400,
    );
    // The token's one slot is spent, so a well-formed publish now waits.
    expect((await attempt({})).statusCode).toBe(429);

    await limited.app.close();
    limited.tokens.close();
  });
});

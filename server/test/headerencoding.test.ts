import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Broker } from '../src/broker.js';
import {
  MAX_TAG_BYTES,
  MAX_TITLE_BYTES,
  TAGS_ENCODING_RULE,
  TAGS_RULE,
  TITLE_ENCODING_RULE,
  TITLE_RULE,
  type Message,
  parseTags,
  parseTitle,
} from '../src/message.js';
import { MessageStore } from '../src/store.js';
import type { TokenStore } from '../src/tokens.js';
import { bearer, buildTestApp } from './helpers.js';

/**
 * A string as Node hands it to a route: header values are decoded latin1, one character
 * per byte received, so this is what a client's UTF-8 bytes look like on arrival.
 * `app.inject` skips the wire, and would otherwise deliver characters Node never would.
 */
const asReceived = (value: string): string => Buffer.from(value, 'utf8').toString('latin1');

/** Raw bytes as a route would see them, for spelling out what is not valid UTF-8. */
const bytes = (...values: number[]): string => Buffer.from(values).toString('latin1');

describe('parseTitle decoding', () => {
  it('reads a UTF-8 title as the characters the client sent', () => {
    expect(parseTitle(asReceived('Café déjà vu'))).toBe('Café déjà vu');
  });

  it('leaves a pure ASCII title exactly as it arrived', () => {
    expect(parseTitle('Deploy finished')).toBe('Deploy finished');
  });

  it('reads a title outside the Basic Multilingual Plane', () => {
    expect(parseTitle(asReceived('build passed 🎉'))).toBe('build passed 🎉');
  });

  it('keeps a trailing character whose last byte is a no-break space in latin1', () => {
    // `à` is 0xC3 0xA0, and 0xA0 alone is latin1's no-break space, which `trim` strips.
    // Trimming before decoding would leave a lone 0xC3 — half a character, no longer
    // valid UTF-8. This is why the decode has to come first.
    expect(parseTitle(asReceived('déjà'))).toBe('déjà');
    expect(parseTitle(asReceived('  déjà  '))).toBe('déjà');
  });

  it('still trims the ASCII space around a decoded title', () => {
    expect(parseTitle(asReceived('  Café  '))).toBe('Café');
  });

  it('refuses a title that is not UTF-8, naming the rule', () => {
    // `Café` as latin1: a lone 0xE9, which is a leading byte with no continuation.
    expect(() => parseTitle(bytes(0x43, 0x61, 0x66, 0xe9))).toThrow(TITLE_ENCODING_RULE);
  });

  it('refuses a truncated multi-byte sequence', () => {
    // The first byte of `é` without its continuation byte.
    expect(() => parseTitle(bytes(0xc3))).toThrow(TITLE_ENCODING_RULE);
  });

  it('refuses a continuation byte with no character to continue', () => {
    expect(() => parseTitle(bytes(0xa9))).toThrow(TITLE_ENCODING_RULE);
  });

  it('reports the encoding rule for a title that is both over-long and not UTF-8', () => {
    // It is not a title at all until it decodes, so that is what the client hears about.
    expect(() => parseTitle(bytes(0xe9).repeat(MAX_TITLE_BYTES + 1))).toThrow(
      TITLE_ENCODING_RULE,
    );
  });

  it('bounds a decoded title by the bytes that arrived, not its characters', () => {
    // 128 characters, 256 bytes: at the limit, though it spells half as much text.
    const atLimit = asReceived('é'.repeat(MAX_TITLE_BYTES / 2));
    expect(parseTitle(atLimit)).toHaveLength(MAX_TITLE_BYTES / 2);

    const overLimit = asReceived('é'.repeat(MAX_TITLE_BYTES / 2 + 1));
    expect(() => parseTitle(overLimit)).toThrow(TITLE_RULE);
  });

  it('reads a blank title as no title', () => {
    expect(parseTitle('   ')).toBeNull();
  });

  it('reads a title of one no-break space as no title', () => {
    // U+00A0 arrives as the two bytes 0xC2 0xA0. Decoded it is a space character, so
    // the title is blank. Trimmed first, its second byte would be eaten as a latin1
    // space and the lone 0xC2 left behind would not decode at all.
    expect(parseTitle(asReceived('\u00a0'))).toBeNull();
  });
});

describe('parseTags decoding', () => {
  it('reads each tag as the characters the client sent', () => {
    expect(parseTags(asReceived('café,déjà,naïve'))).toEqual(['café', 'déjà', 'naïve']);
  });

  it('keeps a tag whose last byte is a no-break space in latin1', () => {
    expect(parseTags(asReceived('  déjà  ,  café  '))).toEqual(['déjà', 'café']);
  });

  it('refuses tags that are not UTF-8, naming the rule', () => {
    expect(() => parseTags(bytes(0x63, 0x61, 0x66, 0xe9))).toThrow(TAGS_ENCODING_RULE);
  });

  it('bounds a decoded tag by the bytes that arrived', () => {
    const atLimit = asReceived('é'.repeat(MAX_TAG_BYTES / 2));
    expect(parseTags(atLimit)).toHaveLength(1);

    expect(() => parseTags(asReceived('é'.repeat(MAX_TAG_BYTES / 2 + 1)))).toThrow(TAGS_RULE);
  });

  it('splits on a comma the same way before and after decoding', () => {
    // A comma is one byte in UTF-8 and never part of another character, so a multi-byte
    // tag cannot hide a separator, nor lose one.
    expect(parseTags(asReceived('🎉,🚀'))).toEqual(['🎉', '🚀']);
  });
});

describe('publish header encoding', () => {
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

  it('stores and delivers an accented title as it was sent', async () => {
    const listener = vi.fn();
    broker.subscribe(['mytopic'], listener);

    const res = await publish({
      'x-title': asReceived('Café déjà vu'),
      'x-tags': asReceived('café,déjà'),
    });

    expect(res.statusCode).toBe(200);
    expect((res.json() as Message).title).toBe('Café déjà vu');

    // The three places a title can be read: the reply, a live subscriber, the backlog.
    expect(listener).toHaveBeenCalledOnce();
    expect((listener.mock.calls[0][0] as Message).title).toBe('Café déjà vu');

    const [replayed] = store.since(['mytopic'], 0);
    expect(replayed.title).toBe('Café déjà vu');
    expect(replayed.tags).toEqual(['café', 'déjà']);
  });

  it('refuses a title that is not UTF-8 with 400, naming the rule', async () => {
    const res = await publish({ 'x-title': bytes(0x43, 0x61, 0x66, 0xe9) });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: TITLE_ENCODING_RULE });
  });

  it('refuses tags that are not UTF-8 with 400, naming the rule', async () => {
    const res = await publish({ 'x-tags': bytes(0xe9) });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: TAGS_ENCODING_RULE });
  });

  it('neither stores nor delivers a message whose title is not UTF-8', async () => {
    const listener = vi.fn();
    broker.subscribe(['mytopic'], listener);

    expect((await publish({ 'x-title': bytes(0xe9) })).statusCode).toBe(400);
    expect(listener).not.toHaveBeenCalled();
    expect(store.since(['mytopic'], 0)).toEqual([]);
  });

  it('leaves a title that is not UTF-8 to the token check', async () => {
    // Auth is a `preValidation` hook: an anonymous client hears about the token it
    // lacks, not the title it sent.
    const res = await app.inject({
      method: 'POST',
      url: '/mytopic',
      headers: { 'x-title': bytes(0xe9) },
      payload: 'hello',
    });

    expect(res.statusCode).toBe(401);
  });
});

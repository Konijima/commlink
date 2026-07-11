import net from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Broker } from '../src/broker.js';
import { BODY_ENCODING_RULE, decodeBody, type Message } from '../src/message.js';
import { MessageStore } from '../src/store.js';
import type { TokenStore } from '../src/tokens.js';
import { buildTestApp } from './helpers.js';

describe('decodeBody', () => {
  it('reads a UTF-8 body as the characters the client sent', () => {
    expect(decodeBody(Buffer.from('Café déjà vu', 'utf8'))).toBe('Café déjà vu');
  });

  it('reads a body outside the Basic Multilingual Plane', () => {
    expect(decodeBody(Buffer.from('build passed 🎉', 'utf8'))).toBe('build passed 🎉');
  });

  it('reads an empty body as the empty string', () => {
    expect(decodeBody(Buffer.alloc(0))).toBe('');
  });

  it('refuses a body that is not UTF-8, naming the rule', () => {
    // `Café` as latin1: a lone 0xE9, a leading byte with no continuation.
    expect(() => decodeBody(Buffer.from([0x43, 0x61, 0x66, 0xe9]))).toThrow(
      BODY_ENCODING_RULE,
    );
  });

  it('refuses a truncated multi-byte sequence', () => {
    expect(() => decodeBody(Buffer.from([0xc3]))).toThrow(BODY_ENCODING_RULE);
  });

  it('refuses a continuation byte with no character to continue', () => {
    expect(() => decodeBody(Buffer.from([0xa9]))).toThrow(BODY_ENCODING_RULE);
  });
});

/**
 * A body carries its bytes verbatim, and `app.inject` cannot: it sizes `Content-Length`
 * from a re-encoded payload, so a raw non-UTF-8 body is rejected as a length mismatch
 * before the encoding is ever judged. These tests speak HTTP on a real socket, writing
 * the body as the exact bytes a client would put on the wire.
 */
interface RawResponse {
  status: number;
  body: string;
}

/** Send a POST whose body is the exact bytes of `body`, and read the response back. */
function rawPublish(
  port: number,
  token: string,
  body: Buffer,
  topic = 'mytopic',
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    const chunks: Buffer[] = [];

    socket.on('error', reject);
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));

    socket.once('connect', () => {
      const head = Buffer.from(
        [
          `POST /${topic} HTTP/1.1`,
          'Host: 127.0.0.1',
          `Authorization: Bearer ${token}`,
          `Content-Length: ${body.length}`,
          // So the server ends the response by closing, and `end` means "all of it".
          'Connection: close',
          '',
          '',
        ].join('\r\n'),
        'utf8',
      );
      socket.write(Buffer.concat([head, body]));
    });

    socket.once('end', () => {
      // The response is the server's own JSON, always UTF-8; only the request body was raw.
      const raw = Buffer.concat(chunks).toString('utf8');
      const separator = raw.indexOf('\r\n\r\n');
      resolve({
        status: Number(raw.slice(9, 12)), // `HTTP/1.1 200 OK` -> `200`
        body: raw.slice(separator + 4),
      });
    });
  });
}

describe('publish body encoding', () => {
  let app: FastifyInstance;
  let broker: Broker;
  let store: MessageStore;
  let tokens: TokenStore;
  let token: string;
  let port: number;

  beforeEach(async () => {
    broker = new Broker();
    store = new MessageStore();
    ({ app, tokens, token } = buildTestApp({ broker, store }));
    await app.listen({ host: '127.0.0.1', port: 0 });
    port = (app.server.address() as net.AddressInfo).port;
  });

  afterEach(async () => {
    await app.close();
    store.close();
    tokens.close();
  });

  it('stores and delivers an accented body as it was sent', async () => {
    const listener = vi.fn();
    broker.subscribe(['mytopic'], listener);

    const response = await rawPublish(port, token, Buffer.from('Café ☕', 'utf8'));

    expect(response.status).toBe(200);
    expect((JSON.parse(response.body) as Message).message).toBe('Café ☕');

    // The three places the body can be read: the reply, a live subscriber, the backlog.
    expect(listener).toHaveBeenCalledOnce();
    expect((listener.mock.calls[0][0] as Message).message).toBe('Café ☕');

    const [replayed] = store.since(['mytopic'], 0);
    expect(replayed.message).toBe('Café ☕');
  });

  it('refuses a body that is not UTF-8 with 400, naming the rule', async () => {
    const response = await rawPublish(port, token, Buffer.from([0x43, 0x61, 0x66, 0xe9]));

    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: BODY_ENCODING_RULE });
  });

  it('neither stores nor delivers a message whose body is not UTF-8', async () => {
    const listener = vi.fn();
    broker.subscribe(['mytopic'], listener);

    const response = await rawPublish(port, token, Buffer.from([0xe9]));

    expect(response.status).toBe(400);
    expect(listener).not.toHaveBeenCalled();
    expect(store.since(['mytopic'], 0)).toEqual([]);
  });

  it('does not charge a non-UTF-8 body to the rate limit', async () => {
    // The body is decoded while it is read — before the auth hook names a token and
    // before the limiter that would charge it runs. So a non-UTF-8 publish is refused
    // (400) having spent no budget, the same as an over-long one (413, pinned by
    // `bodylimit.test.ts`) and an unauthenticated one (401). One slot per token, so a
    // charged refusal would leave nothing for the valid publish that follows.
    const limited = buildTestApp({ publishRateLimit: 1 });
    await limited.app.listen({ host: '127.0.0.1', port: 0 });
    const limitedPort = (limited.app.server.address() as net.AddressInfo).port;

    try {
      const refused = await rawPublish(
        limitedPort,
        limited.token,
        Buffer.from([0x43, 0x61, 0x66, 0xe9]),
      );
      expect(refused.status).toBe(400);
      expect(JSON.parse(refused.body)).toEqual({ error: BODY_ENCODING_RULE });

      // The token's one slot is still there to spend.
      const ok = await rawPublish(
        limitedPort,
        limited.token,
        Buffer.from('hello', 'utf8'),
      );
      expect(ok.status).toBe(200);
    } finally {
      await limited.app.close();
      limited.tokens.close();
    }
  });
});

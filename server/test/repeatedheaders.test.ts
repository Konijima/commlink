import net from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  MAX_TITLE_BYTES,
  TITLE_RULE,
  headerValue,
  parseSince,
  type Message,
} from '../src/message.js';
import type { TokenStore } from '../src/tokens.js';
import { buildTestApp } from './helpers.js';

/**
 * What a client sends twice, a route sees once — and Node, not this server, decides how.
 * That folding is invisible to `app.inject`, which hands a route whatever headers object
 * it was given and will happily deliver an array Node would never produce. So these tests
 * speak HTTP on a real socket, which is the only place the question can be asked.
 */

interface RawResponse {
  status: number;
  body: string;
}

/** Send `lines` and `body` verbatim, and read the whole response back. */
function rawRequest(port: number, lines: string[], body = ''): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    const chunks: Buffer[] = [];

    socket.on('error', reject);
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));

    socket.once('connect', () => {
      socket.write(
        [
          ...lines,
          `Content-Length: ${Buffer.byteLength(body)}`,
          // So the server ends the response by closing, and `end` means "all of it".
          'Connection: close',
          '',
          body,
        ].join('\r\n'),
      );
    });

    socket.once('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const separator = raw.indexOf('\r\n\r\n');
      resolve({
        status: Number(raw.slice(9, 12)), // `HTTP/1.1 200 OK` -> `200`
        body: raw.slice(separator + 4),
      });
    });
  });
}

describe('a header a client sent twice', () => {
  let app: FastifyInstance;
  let tokens: TokenStore;
  let token: string;
  let port: number;

  beforeEach(async () => {
    ({ app, tokens, token } = buildTestApp());
    await app.listen({ host: '127.0.0.1', port: 0 });
    port = (app.server.address() as net.AddressInfo).port;
  });

  afterEach(async () => {
    await app.close();
    tokens.close();
  });

  /** Publish `hello` to `demo`, with `extra` header lines spelled out on the wire. */
  const publish = (
    extra: string[],
    auth: string[] = [`Authorization: Bearer ${token}`],
  ) =>
    rawRequest(
      port,
      ['POST /demo HTTP/1.1', 'Host: 127.0.0.1', ...auth, ...extra],
      'hello',
    );

  it('folds a repeated X-Title into one comma-joined value', async () => {
    const response = await publish(['X-Title: alpha', 'X-Title: beta']);

    expect(response.status).toBe(200);
    expect((JSON.parse(response.body) as Message).title).toBe('alpha, beta');
  });

  it('measures the size limit against the joined title, so a repeat buys no room', async () => {
    // Neither half is over the limit; together they are. The bound has to see the value
    // the subscriber would be sent, not the longest single line the client wrote.
    const half = 'a'.repeat(200);
    const response = await publish([`X-Title: ${half}`, `X-Title: ${half}`]);

    expect(Buffer.byteLength(half)).toBeLessThan(MAX_TITLE_BYTES);
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: TITLE_RULE });
  });

  it('folds a repeated X-Tags, which the tag split then separates again', async () => {
    const response = await publish(['X-Tags: one', 'X-Tags: two']);

    expect(response.status).toBe(200);
    expect((JSON.parse(response.body) as Message).tags).toEqual(['one', 'two']);
  });

  it('refuses a repeated X-Priority, which folds into something that is not an integer', async () => {
    const response = await publish(['X-Priority: 1', 'X-Priority: 5']);

    expect(response.status).toBe(400);
    expect((JSON.parse(response.body) as { error: string }).error).toContain('priority');
  });

  it('keeps the first Authorization header, so a second cannot authorize a request', async () => {
    const response = await publish(
      [],
      ['Authorization: Bearer not-a-token', `Authorization: Bearer ${token}`],
    );

    expect(response.status).toBe(401);
  });

  it('keeps the first Authorization header, so a second cannot unauthorize one', async () => {
    const response = await publish(
      [],
      [`Authorization: Bearer ${token}`, 'Authorization: Bearer not-a-token'],
    );

    expect(response.status).toBe(200);
  });
});

describe('headerValue', () => {
  it('takes the first of an array, which only a repeated query parameter produces', () => {
    expect(headerValue(['first', 'second'])).toBe('first');
  });

  it('passes a lone value through, and reports an absent one as absent', () => {
    expect(headerValue('only')).toBe('only');
    expect(headerValue(undefined)).toBeUndefined();
  });

  it('reads a repeated ?since= as the first one asked for', () => {
    expect(parseSince(['5', '9'])).toBe(5);
  });
});

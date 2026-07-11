import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { NO_TOKENS_WARNING, buildApp } from '../src/app.js';
import { Broker } from '../src/broker.js';
import {
  DEFAULT_LOG_LEVEL,
  LOG_LEVELS,
  buildLoggerOptions,
  logLevelRule,
  parseLogLevel,
  redactAuthInUrl,
} from '../src/logging.js';
import { TokenStore } from '../src/tokens.js';

describe('parseLogLevel', () => {
  it('defaults to info when unset or blank', () => {
    expect(parseLogLevel(undefined)).toBe(DEFAULT_LOG_LEVEL);
    expect(parseLogLevel('')).toBe(DEFAULT_LOG_LEVEL);
    expect(parseLogLevel('   ')).toBe(DEFAULT_LOG_LEVEL);
  });

  it('accepts every level it documents', () => {
    for (const level of LOG_LEVELS) {
      expect(parseLogLevel(level)).toBe(level);
    }
  });

  it('is case- and whitespace-insensitive', () => {
    expect(parseLogLevel('INFO')).toBe('info');
    expect(parseLogLevel('  Debug  ')).toBe('debug');
  });

  it('refuses an unknown level rather than guessing one', () => {
    expect(() => parseLogLevel('verbose')).toThrow(logLevelRule());
    expect(() => parseLogLevel('9')).toThrow(logLevelRule());
  });
});

describe('redactAuthInUrl', () => {
  it('masks only the auth value, leaving the rest of the URL intact', () => {
    expect(redactAuthInUrl('/mytopic/ws?auth=supersecret')).toBe(
      '/mytopic/ws?auth=[REDACTED]',
    );
    expect(redactAuthInUrl('/a,b,c/json?since=100&auth=supersecret')).toBe(
      '/a,b,c/json?since=100&auth=[REDACTED]',
    );
  });

  it('masks the token wherever the auth parameter sits', () => {
    expect(redactAuthInUrl('/t/ws?auth=supersecret&since=100')).toBe(
      '/t/ws?auth=[REDACTED]&since=100',
    );
  });

  it('is case-insensitive about the parameter name', () => {
    expect(redactAuthInUrl('/t/ws?AUTH=supersecret')).toBe('/t/ws?AUTH=[REDACTED]');
  });

  it('leaves a URL without an auth parameter untouched', () => {
    expect(redactAuthInUrl('/mytopic/ws?since=100')).toBe('/mytopic/ws?since=100');
    expect(redactAuthInUrl('/healthz')).toBe('/healthz');
  });
});

describe('request logging', () => {
  let app: FastifyInstance;
  let tokens: TokenStore;

  afterEach(async () => {
    await app.close();
    tokens.close();
  });

  /** A pino destination that keeps every line it is written, so the test can read them back. */
  function capturingStream(): { lines: string[]; stream: NodeJS.WritableStream } {
    const lines: string[] = [];
    const stream = {
      write(chunk: string) {
        lines.push(chunk);
      },
    } as unknown as NodeJS.WritableStream;
    return { lines, stream };
  }

  it('redacts a subscribe token from the request log', async () => {
    const { lines, stream } = capturingStream();
    tokens = new TokenStore();
    app = buildApp({ tokens, logger: buildLoggerOptions('info', stream) });
    await app.ready();

    // A bogus token still reaches the request log: the incoming-request line is written
    // before the route rejects it. That is exactly the leak the redaction guards against.
    const secret = 'supersecret-token-value';
    await app.inject({ method: 'GET', url: `/mytopic/json?auth=${secret}` });

    const output = lines.join('');
    expect(output).toContain('"url":"/mytopic/json?auth=[REDACTED]"');
    expect(output).not.toContain(secret);
  });

  it('logs an unauthenticated path as it arrived', async () => {
    const { lines, stream } = capturingStream();
    tokens = new TokenStore();
    app = buildApp({ tokens, logger: buildLoggerOptions('info', stream) });
    await app.ready();

    await app.inject({ method: 'GET', url: '/healthz' });

    expect(lines.join('')).toContain('"url":"/healthz"');
  });

  it('warns at startup when the token store authorizes nobody', async () => {
    const { lines, stream } = capturingStream();
    // A store with no tokens refuses every publish and subscribe with a 401, which looks
    // from the outside like a broken server. The warning names the cause and the fix.
    tokens = new TokenStore();
    app = buildApp({ tokens, logger: buildLoggerOptions('info', stream) });
    await app.ready();

    const output = lines.join('');
    expect(output).toContain(NO_TOKENS_WARNING);
    expect(output).toContain('"level":40'); // pino's numeric code for warn
  });

  it('stays quiet at startup once a token exists', async () => {
    const { lines, stream } = capturingStream();
    tokens = new TokenStore();
    tokens.create('pixel');
    app = buildApp({ tokens, logger: buildLoggerOptions('info', stream) });
    await app.ready();

    expect(lines.join('')).not.toContain(NO_TOKENS_WARNING);
  });

  it('logs the forwarded Host but not the forwarded client address', async () => {
    const { lines, stream } = capturingStream();
    tokens = new TokenStore();
    app = buildApp({ tokens, logger: buildLoggerOptions('info', stream) });
    await app.ready();

    // Behind the reverse proxy documented in deploy/nginx.conf: the request arrives from
    // the proxy, carrying the client's original host and address in the standard forwarded
    // headers. The server trusts no proxy headers, so `request.ip` is the connecting peer
    // (the proxy) rather than X-Forwarded-For — this pins the behavior deploy/nginx.conf's
    // comment describes, so flipping on proxy trust later without updating that doc fails here.
    await app.inject({
      method: 'GET',
      url: '/healthz',
      remoteAddress: '10.0.0.1',
      headers: {
        host: 'push.example.com',
        'x-forwarded-for': '203.0.113.9',
        'x-real-ip': '203.0.113.9',
        'x-forwarded-proto': 'https',
      },
    });

    const output = lines.join('');
    // The forwarded Host reaches the request log.
    expect(output).toContain('"host":"push.example.com"');
    // The logged remote address is the proxy, not the forwarded client address.
    expect(output).toContain('"remoteAddress":"10.0.0.1"');
    expect(output).not.toContain('203.0.113.9');
  });

  it('logs when delivering a message to a subscriber throws', async () => {
    const { lines, stream } = capturingStream();
    tokens = new TokenStore();
    const token = tokens.create('pixel');
    // Inject the broker so the test can attach a subscriber whose delivery throws; the app
    // wires its logger onto whatever broker it is given.
    const broker = new Broker();
    app = buildApp({ broker, tokens, logger: buildLoggerOptions('info', stream) });
    await app.ready();

    broker.subscribe(['mytopic'], () => {
      throw new Error('subscriber exploded');
    });

    // Publishing fans out to the throwing subscriber, so the broker's error hook fires.
    const res = await app.inject({
      method: 'POST',
      url: '/mytopic',
      headers: { authorization: `Bearer ${token}` },
      payload: 'hello',
    });
    // The publish itself still succeeds — one broken subscriber does not fail the publish.
    expect(res.statusCode).toBe(200);

    const output = lines.join('');
    expect(output).toContain('delivering a message to a subscriber failed');
    expect(output).toContain('"level":50'); // pino's numeric code for error
    expect(output).toContain('subscriber exploded'); // the thrown error is logged
    expect(output).toContain('"topic":"mytopic"');
  });
});

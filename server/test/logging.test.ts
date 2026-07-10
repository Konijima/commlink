import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
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
});

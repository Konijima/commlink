import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import type { Message } from '../src/message.js';
import { RETENTION_HOURS, parseRetentionHours } from '../src/retention.js';
import { MessageStore } from '../src/store.js';

/**
 * Short enough that a test finishes in milliseconds, long enough that a slow machine
 * does not tick twice where the test expects once. The production interval is an hour.
 */
const SWEEP_INTERVAL_MS = 25;

const HOUR_SECONDS = 3_600;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

let counter = 0;

/** A message on `mytopic`, published `agoSeconds` ago. */
function message(agoSeconds: number): Message {
  counter += 1;
  return {
    id: `id-${counter}`,
    topic: 'mytopic',
    title: null,
    message: `message ${counter}`,
    priority: 3,
    tags: [],
    timestamp: now() - agoSeconds,
  };
}

function stored(store: MessageStore): string[] {
  return store.since(['mytopic'], 0).map((message) => message.message);
}

describe('parseRetentionHours', () => {
  it('defaults to the documented window when unset', () => {
    expect(parseRetentionHours(undefined)).toBe(RETENTION_HOURS);
    expect(RETENTION_HOURS).toBe(72);
  });

  it('accepts a whole number of hours', () => {
    expect(parseRetentionHours('1')).toBe(1);
    expect(parseRetentionHours(' 168 ')).toBe(168);
  });

  it.each(['0', '-1', '1.5', '', ' ', 'abc', '72h', '1e3', '0x10'])(
    'rejects %o rather than falling back to a default',
    (raw) => {
      // A window that quietly became the default — or `NaN`, which no message is older
      // than — would leave the database growing as if retention were never configured.
      expect(() => parseRetentionHours(raw)).toThrow(RangeError);
    },
  );
});

describe('retention sweep', () => {
  let app: FastifyInstance | undefined;
  let store: MessageStore | undefined;

  afterEach(async () => {
    await app?.close();
    store?.close();
    app = undefined;
    store = undefined;
  });

  /** An app over a store the test can inspect. An injected store is the test's to close. */
  function build(retentionHours = 1): { app: FastifyInstance; store: MessageStore } {
    store = new MessageStore();
    app = buildApp({
      store,
      retentionHours,
      retentionSweepIntervalMs: SWEEP_INTERVAL_MS,
    });
    return { app, store };
  }

  it('sweeps expired messages as the server starts', async () => {
    const { app, store } = build();
    store.append({ ...message(2 * HOUR_SECONDS), message: 'expired' });
    store.append({ ...message(60), message: 'fresh' });

    await app.ready();

    // A server that was down while messages expired must not serve them on the way up.
    expect(stored(store)).toEqual(['fresh']);
  });

  it('keeps sweeping on the interval', async () => {
    const { app, store } = build();
    await app.ready();

    store.append({ ...message(2 * HOUR_SECONDS), message: 'expired' });

    await vi.waitFor(() => expect(stored(store)).toEqual([]));
  });

  it('keeps a message that is inside the window', async () => {
    const { app, store } = build();
    await app.ready();

    store.append({ ...message(30 * 60), message: 'fresh' });

    await sleep(SWEEP_INTERVAL_MS * 4);
    expect(stored(store)).toEqual(['fresh']);
  });

  it('measures the window in hours', async () => {
    const { app, store } = build(2);
    store.append({ ...message(3 * HOUR_SECONDS), message: 'expired' });
    store.append({ ...message(90 * 60), message: 'fresh' });

    await app.ready();

    expect(stored(store)).toEqual(['fresh']);
  });

  it('stops sweeping once the server closes', async () => {
    const { app, store } = build();
    await app.ready();
    await app.close();

    store.append({ ...message(2 * HOUR_SECONDS), message: 'expired' });

    // Had the timer outlived the app, several intervals would land here.
    await sleep(SWEEP_INTERVAL_MS * 4);
    expect(stored(store)).toEqual(['expired']);
  });

  it('leaves an injected store open for its owner', async () => {
    const { app, store } = build();
    await app.ready();
    await app.close();

    // Closing it here would throw if the app had already done so.
    expect(() => store.since(['mytopic'], 0)).not.toThrow();
  });

  it.each([0, -1, 1.5, Number.NaN])('refuses to build with a retention of %o hours', (hours) => {
    expect(() => buildApp({ retentionHours: hours })).toThrow(RangeError);
  });
});

describe('retention and replay', () => {
  it('does not replay a message the sweep has removed', async () => {
    const store = new MessageStore();
    const app = buildApp({ store, retentionHours: 1, retentionSweepIntervalMs: SWEEP_INTERVAL_MS });
    const controller = new AbortController();

    store.append({ ...message(2 * HOUR_SECONDS), message: 'expired' });
    store.append({ ...message(60), message: 'fresh' });

    try {
      // A real socket: `app.inject` buffers a response, and this one never ends.
      const httpBase = await app.listen({ port: 0, host: '127.0.0.1' });

      const response = await fetch(`${httpBase}/mytopic/json?since=0`, {
        signal: controller.signal,
      });
      expect(response.status).toBe(200);

      // Replay is oldest-first, so a surviving `expired` would arrive on this line.
      const { value } = await response.body!.getReader().read();
      const first = JSON.parse(new TextDecoder().decode(value).split('\n')[0]) as Message;
      expect(first.message).toBe('fresh');
    } finally {
      controller.abort();
      await app.close();
      store.close();
    }
  });
});

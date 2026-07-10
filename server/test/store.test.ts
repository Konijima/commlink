import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Message } from '../src/message.js';
import { MessageStore } from '../src/store.js';

let counter = 0;

/** A message with distinct, predictable fields; override what a test cares about. */
function message(fields: Partial<Message> = {}): Message {
  counter += 1;
  return {
    id: `id-${counter}`,
    topic: 'mytopic',
    title: null,
    message: `message ${counter}`,
    priority: 3,
    tags: [],
    timestamp: 1_700_000_000,
    ...fields,
  };
}

describe('MessageStore', () => {
  let store: MessageStore;

  beforeEach(() => {
    store = new MessageStore();
  });

  afterEach(() => {
    store.close();
  });

  it('returns nothing for a topic that has never been published to', () => {
    expect(store.since(['mytopic'], 0)).toEqual([]);
  });

  it('returns nothing when asked for no topics', () => {
    store.append(message());

    expect(store.since([], 0)).toEqual([]);
  });

  it('round-trips every field of a message', () => {
    const published = message({
      title: 'Deploy finished',
      message: '{"deploy":"done"}',
      priority: 5,
      tags: ['ci', 'deploy'],
    });

    store.append(published);

    expect(store.since(['mytopic'], 0)).toEqual([published]);
  });

  it('round-trips an absent title and an empty tag list', () => {
    const published = message({ title: null, tags: [] });

    store.append(published);

    const [stored] = store.since(['mytopic'], 0);
    expect(stored?.title).toBeNull();
    expect(stored?.tags).toEqual([]);
  });

  it('rejects a message whose id is already stored', () => {
    const published = message();

    store.append(published);

    expect(() => store.append(published)).toThrow();
  });

  it('returns only the topics that were asked for', () => {
    store.append(message({ topic: 'alerts' }));
    store.append(message({ topic: 'deploys' }));
    store.append(message({ topic: 'backups' }));

    const topics = store.since(['alerts', 'backups'], 0).map((stored) => stored.topic);
    expect(topics).toEqual(['alerts', 'backups']);
  });

  it('replays across several topics at once, oldest first', () => {
    const first = message({ topic: 'alerts' });
    const second = message({ topic: 'deploys' });
    const third = message({ topic: 'alerts' });

    store.append(first);
    store.append(second);
    store.append(third);

    expect(store.since(['alerts', 'deploys'], 0)).toEqual([first, second, third]);
  });

  it('excludes messages published before the requested timestamp', () => {
    const old = message({ timestamp: 1000 });
    const recent = message({ timestamp: 2000 });

    store.append(old);
    store.append(recent);

    expect(store.since(['mytopic'], 1500)).toEqual([recent]);
  });

  it('includes a message published in the requested second', () => {
    // The bound is inclusive: whole-second timestamps mean an exclusive one would
    // silently drop a message published in the same second as the client's last-seen.
    const published = message({ timestamp: 2000 });

    store.append(published);

    expect(store.since(['mytopic'], 2000)).toEqual([published]);
  });

  it('replays messages sharing a timestamp in the order they were published', () => {
    const first = message({ timestamp: 2000 });
    const second = message({ timestamp: 2000 });
    const third = message({ timestamp: 2000 });

    store.append(first);
    store.append(second);
    store.append(third);

    expect(store.since(['mytopic'], 2000)).toEqual([first, second, third]);
  });

  describe('on disk', () => {
    let directory: string;
    let path: string;

    beforeEach(() => {
      directory = mkdtempSync(join(tmpdir(), 'commlink-store-'));
      path = join(directory, 'commlink.sqlite');
    });

    afterEach(() => {
      rmSync(directory, { recursive: true, force: true });
    });

    it('keeps messages across a reopen of the same file', () => {
      const published = message({ title: 'Deploy finished', tags: ['ci'] });

      const first = new MessageStore(path);
      first.append(published);
      first.close();

      const second = new MessageStore(path);
      try {
        expect(second.since(['mytopic'], 0)).toEqual([published]);
      } finally {
        second.close();
      }
    });

    it('creates the database file on first open', () => {
      const created = new MessageStore(path);
      try {
        expect(created.since(['mytopic'], 0)).toEqual([]);
      } finally {
        created.close();
      }
    });
  });
});

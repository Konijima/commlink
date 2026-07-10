import { describe, expect, it } from 'vitest';
import {
  MAX_SUBSCRIBE_TOPICS,
  MAX_TOPIC_LENGTH,
  MAX_TOPIC_LIST_LENGTH,
  SINCE_RULE,
  TOPIC_LIST_RULE,
  parseSince,
  parseTopicList,
} from '../src/message.js';

/**
 * The longest list the server accepts: every topic slot filled to the maximum name
 * length, with distinct names so none of them collapse.
 */
function longestTopicList(): string {
  return Array.from({ length: MAX_SUBSCRIBE_TOPICS }, (_, i) =>
    String(i).padStart(MAX_TOPIC_LENGTH, 'a'),
  ).join(',');
}

describe('parseTopicList', () => {
  it('reads a single topic as a one-entry list', () => {
    expect(parseTopicList('alpha')).toEqual(['alpha']);
  });

  it('splits a comma-separated list', () => {
    expect(parseTopicList('alpha,beta,gamma')).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('keeps the order the client asked for', () => {
    expect(parseTopicList('gamma,alpha,beta')).toEqual(['gamma', 'alpha', 'beta']);
  });

  it('collapses a repeated topic to one entry', () => {
    expect(parseTopicList('alpha,beta,alpha')).toEqual(['alpha', 'beta']);
  });

  it('accepts a list exactly at the limit', () => {
    const names = Array.from({ length: MAX_SUBSCRIBE_TOPICS }, (_, i) => `topic${i}`);

    expect(parseTopicList(names.join(','))).toEqual(names);
  });

  it('rejects a list one over the limit', () => {
    const names = Array.from({ length: MAX_SUBSCRIBE_TOPICS + 1 }, (_, i) => `topic${i}`);

    expect(() => parseTopicList(names.join(','))).toThrow(TOPIC_LIST_RULE);
  });

  it('counts repeats against the limit, before they collapse', () => {
    // Otherwise a client could pin an arbitrarily long URL by repeating one name.
    const names = Array.from({ length: MAX_SUBSCRIBE_TOPICS + 1 }, () => 'alpha');

    expect(() => parseTopicList(names.join(','))).toThrow(TOPIC_LIST_RULE);
  });

  it.each(['bad.topic', 'bad topic', 'a'.repeat(65), 'healthz', ''])(
    'rejects %j as a topic name',
    (name) => {
      expect(() => parseTopicList(name)).toThrow(/^topic must be/);
    },
  );

  it.each(['alpha,', ',alpha', 'alpha,,beta'])('rejects the empty entry in %j', (raw) => {
    expect(() => parseTopicList(raw)).toThrow(/^topic must be/);
  });

  it('rejects the whole list when one entry is invalid', () => {
    expect(() => parseTopicList('alpha,bad.topic,gamma')).toThrow(/^topic must be/);
  });

  it('accepts the longest list MAX_TOPIC_LIST_LENGTH describes', () => {
    // The router sizes its path-parameter limit from that constant, so it has to be
    // the true length of a full list — not merely an upper bound on one.
    const longest = longestTopicList();

    expect(longest).toHaveLength(MAX_TOPIC_LIST_LENGTH);
    expect(parseTopicList(longest)).toHaveLength(MAX_SUBSCRIBE_TOPICS);
  });
});

describe('parseSince', () => {
  it('returns null when the parameter is absent, meaning no replay', () => {
    expect(parseSince(undefined)).toBeNull();
  });

  it('parses a Unix timestamp in seconds', () => {
    expect(parseSince('1700000000')).toBe(1_700_000_000);
  });

  it('accepts 0, which is how a client asks for the whole backlog', () => {
    expect(parseSince('0')).toBe(0);
  });

  it('ignores surrounding whitespace', () => {
    expect(parseSince(' 1700000000 ')).toBe(1_700_000_000);
  });

  it('takes the first value when the parameter repeats', () => {
    expect(parseSince(['1700000000', '1800000000'])).toBe(1_700_000_000);
  });

  it.each([
    ['an empty value', ''],
    ['only whitespace', '   '],
    ['a negative timestamp', '-1'],
    ['a fractional timestamp', '1.5'],
    ['exponent notation', '1e3'],
    ['hexadecimal', '0x10'],
    ['a leading plus', '+1'],
    ['a word', 'yesterday'],
    ['digits with a trailing suffix', '12abc'],
  ])('rejects %s', (_description, raw) => {
    expect(() => parseSince(raw)).toThrow(SINCE_RULE);
  });

  it('rejects a timestamp past the safe-integer range', () => {
    // 2^53 + 1, which a double cannot tell apart from 2^53.
    expect(() => parseSince('9007199254740993')).toThrow(SINCE_RULE);
  });
});

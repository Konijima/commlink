import { describe, expect, it } from 'vitest';
import {
  MAX_SUBSCRIBE_TOPICS,
  MAX_TOPIC_LENGTH,
  MAX_TOPIC_LIST_LENGTH,
  TOPIC_LIST_RULE,
  parseTopicList,
} from '../src/message';

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

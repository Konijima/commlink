import { describe, expect, it } from 'vitest';
import { DEFAULT_HOST, parseHost } from '../src/host.js';

describe('parseHost', () => {
  it('defaults to loopback when unset', () => {
    expect(parseHost(undefined)).toBe(DEFAULT_HOST);
    expect(DEFAULT_HOST).toBe('127.0.0.1');
  });

  it('passes a non-blank host through, trimmed', () => {
    // A hostname, an all-interfaces bind or a specific address are all legitimate on a
    // trusted network, so the value is not second-guessed beyond trimming stray space.
    expect(parseHost('127.0.0.1')).toBe('127.0.0.1');
    expect(parseHost('0.0.0.0')).toBe('0.0.0.0');
    expect(parseHost('::')).toBe('::');
    expect(parseHost('example.internal')).toBe('example.internal');
    expect(parseHost('  ::1  ')).toBe('::1');
  });

  it.each([
    ['an empty value', ''],
    ['whitespace that trims to nothing', '   '],
  ])('rejects %s rather than binding every interface', (_case, raw) => {
    // `process.env.HOST ?? DEFAULT_HOST` would let each of these through as-is, and `listen`
    // reads a blank host as "unspecified" — binding every interface instead of loopback.
    expect(() => parseHost(raw)).toThrow(RangeError);
  });
});

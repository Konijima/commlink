import { describe, expect, it } from 'vitest';
import { DEFAULT_PORT, parsePort } from '../src/port.js';

describe('parsePort', () => {
  it('defaults to the documented port when unset', () => {
    expect(parsePort(undefined)).toBe(DEFAULT_PORT);
    expect(DEFAULT_PORT).toBe(4500);
  });

  it('accepts a port in the 16-bit range', () => {
    expect(parsePort('4500')).toBe(4500);
    expect(parsePort(' 8080 ')).toBe(8080);
    expect(parsePort('1')).toBe(1);
    expect(parsePort('65535')).toBe(65535);
  });

  it('accepts 0, which asks the OS for a free ephemeral port', () => {
    // The smoke run and the shutdown test bind PORT=0 so they never collide with a dev
    // server; rejecting it would break both.
    expect(parsePort('0')).toBe(0);
  });

  it.each([
    ['a non-number Number would take as NaN', 'abc'],
    ['a fraction listen refuses', '8080.5'],
    ['a negative', '-1'],
    ['a port past the 16-bit range', '65536'],
    ['a wildly out-of-range port', '99999'],
    ['exponent notation Number would take', '1e3'],
    ['hex Number would take', '0x10'],
    ['a value with a unit suffix', '4500x'],
    ['an empty value', ''],
    ['whitespace that trims to nothing', '   '],
  ])('rejects %s rather than handing it to listen', (_case, raw) => {
    // Left to `Number(process.env.PORT)`, each of these reaches `listen` as a NaN or an
    // out-of-range port and fails with an opaque stack trace after the database is opened.
    expect(() => parsePort(raw)).toThrow(RangeError);
  });
});

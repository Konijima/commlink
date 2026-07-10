import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.js';
import { MessageStore } from '../src/store.js';
import { TOKEN_NAME_RULE, TokenStore, hashToken, mintToken } from '../src/tokens.js';

describe('mintToken', () => {
  it('mints a token of 32 bytes, base64url-encoded', () => {
    expect(mintToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('never mints the same token twice', () => {
    const minted = new Set(Array.from({ length: 100 }, () => mintToken()));

    expect(minted.size).toBe(100);
  });
});

describe('hashToken', () => {
  it('hashes to 64 hex characters', () => {
    expect(hashToken('a-token')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashes the same token to the same digest', () => {
    expect(hashToken('a-token')).toBe(hashToken('a-token'));
  });

  it('hashes different tokens to different digests', () => {
    expect(hashToken('a-token')).not.toBe(hashToken('b-token'));
  });
});

describe('TokenStore', () => {
  let tokens: TokenStore;

  beforeEach(() => {
    tokens = new TokenStore();
  });

  afterEach(() => {
    tokens.close();
  });

  it('verifies a token it just minted', () => {
    const token = tokens.create('pixel');

    expect(tokens.verify(token)).toBe(true);
  });

  it('verifies each of several tokens', () => {
    const pixel = tokens.create('pixel');
    const laptop = tokens.create('laptop');

    expect(tokens.verify(pixel)).toBe(true);
    expect(tokens.verify(laptop)).toBe(true);
  });

  it('mints a distinct token per name', () => {
    expect(tokens.create('pixel')).not.toBe(tokens.create('laptop'));
  });

  it.each([
    ['a token that was never issued', mintToken()],
    ['the empty string', ''],
    ['the hash of a real token, rather than the token', hashToken('pixel')],
  ])('refuses %s', (_name, candidate) => {
    tokens.create('pixel');

    expect(tokens.verify(candidate)).toBe(false);
  });

  it('authorizes nobody before a token is minted', () => {
    expect(tokens.verify(mintToken())).toBe(false);
  });

  describe('identify', () => {
    it('names the token it just minted', () => {
      expect(tokens.identify(tokens.create('pixel'))).not.toBeNull();
    });

    it('gives each token a distinct name', () => {
      const pixel = tokens.identify(tokens.create('pixel'));
      const laptop = tokens.identify(tokens.create('laptop'));

      expect(pixel).not.toBe(laptop);
    });

    it('gives one token the same name every time it is presented', () => {
      const token = tokens.create('pixel');

      expect(tokens.identify(token)).toBe(tokens.identify(token));
    });

    it.each([
      ['a token that was never issued', mintToken()],
      ['the empty string', ''],
    ])('does not name %s', (_name, candidate) => {
      tokens.create('pixel');

      expect(tokens.identify(candidate)).toBeNull();
    });

    it('names no token that could be confused with none', () => {
      // Ids come from `INTEGER PRIMARY KEY AUTOINCREMENT`, which starts at 1, so no
      // real token is ever named by a value a caller might read as absent.
      expect(tokens.identify(tokens.create('pixel'))).toBeGreaterThan(0);
    });
  });

  it.each(['', 'has space', 'has.dot', 'a'.repeat(65)])(
    'refuses to mint the name %j',
    (name) => {
      expect(() => tokens.create(name)).toThrow(RangeError);
      expect(() => tokens.create(name)).toThrow(TOKEN_NAME_RULE);
    },
  );

  it('accepts a name at the maximum length', () => {
    const token = tokens.create('a'.repeat(64));

    expect(tokens.verify(token)).toBe(true);
  });

  it('refuses a second token under a name already in use', () => {
    tokens.create('pixel');

    expect(() => tokens.create('pixel')).toThrow(/already exists/);
  });

  it('leaves the first token working after a duplicate name is refused', () => {
    const token = tokens.create('pixel');

    expect(() => tokens.create('pixel')).toThrow();
    expect(tokens.verify(token)).toBe(true);
  });

  describe('on disk', () => {
    let directory: string;
    let path: string;

    beforeEach(async () => {
      directory = await mkdtemp(join(tmpdir(), 'commlink-tokens-'));
      path = join(directory, 'commlink.sqlite');
    });

    afterEach(async () => {
      await rm(directory, { recursive: true, force: true });
    });

    it('verifies a token minted by an earlier process', () => {
      const minting = new TokenStore(path);
      const token = minting.create('pixel');
      minting.close();

      // What `token:create` writes, the next server start has to accept.
      const serving = new TokenStore(path);
      try {
        expect(serving.verify(token)).toBe(true);
      } finally {
        serving.close();
      }
    });

    it('stores only the hash, so a stolen database yields no usable token', () => {
      const store = new TokenStore(path);
      const token = store.create('pixel');
      store.close();

      // Read the row back with no help from the store, and look for the token itself.
      const db = openDatabase(path);
      try {
        const row = db.prepare(`SELECT name, hash FROM tokens`).get() as {
          name: string;
          hash: string;
        };

        expect(row.name).toBe('pixel');
        expect(row.hash).toBe(hashToken(token));
        expect(Object.values(row)).not.toContain(token);
      } finally {
        db.close();
      }
    });

    it('shares one database file with the message store', () => {
      // `server.ts` opens both against `DB_PATH`. Each holds its own connection, and
      // neither may trip over the other's schema.
      const messages = new MessageStore(path);
      const store = new TokenStore(path);
      try {
        const token = store.create('pixel');

        expect(store.verify(token)).toBe(true);
        expect(messages.since(['alpha'], 0)).toEqual([]);
      } finally {
        store.close();
        messages.close();
      }
    });
  });
});

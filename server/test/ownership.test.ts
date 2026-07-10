import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { MessageStore } from '../src/store.js';
import { TokenStore } from '../src/tokens.js';

/**
 * Who closes a store. The app owns a store it built for itself and must close it with
 * the app; a store handed in is the caller's, and closing it out from under them would
 * leave the other process holding a database it can no longer read. Closing a
 * better-sqlite3 connection twice is a no-op, so a test that only counted closes could
 * not tell a wrongly-closed injected store from a rightly-closed owned one — the
 * injected halves therefore prove the store is still usable after the app is gone.
 */
describe('store ownership', () => {
  describe('a store the app built for itself', () => {
    it('closes the message store it created', async () => {
      const closeSpy = vi.spyOn(MessageStore.prototype, 'close');

      const app = buildApp();
      await app.ready();
      await app.close();

      expect(closeSpy).toHaveBeenCalledTimes(1);
      closeSpy.mockRestore();
    });

    it('closes the token store it created', async () => {
      const closeSpy = vi.spyOn(TokenStore.prototype, 'close');

      const app = buildApp();
      await app.ready();
      await app.close();

      expect(closeSpy).toHaveBeenCalledTimes(1);
      closeSpy.mockRestore();
    });
  });

  describe('a store handed in', () => {
    it('leaves an injected message store open for its owner to close', async () => {
      const store = new MessageStore();
      const tokens = new TokenStore();
      const closeSpy = vi.spyOn(store, 'close');

      const app = buildApp({ store, tokens });
      await app.ready();
      await app.close();

      expect(closeSpy).not.toHaveBeenCalled();
      // A closed better-sqlite3 connection throws on use, so a still-answering query is
      // proof the app left the store alone — not merely that it skipped calling close.
      expect(store.since(['mytopic'], 0)).toEqual([]);

      store.close();
      tokens.close();
    });

    it('leaves an injected token store open for its owner to close', async () => {
      const store = new MessageStore();
      const tokens = new TokenStore();
      const closeSpy = vi.spyOn(tokens, 'close');

      const app = buildApp({ store, tokens });
      await app.ready();
      await app.close();

      expect(closeSpy).not.toHaveBeenCalled();
      expect(tokens.list()).toEqual([]);

      store.close();
      tokens.close();
    });
  });
});

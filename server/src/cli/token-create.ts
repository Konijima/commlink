/**
 * Mint a token that may publish to and subscribe from this server.
 *
 *     pnpm token:create pixel
 *
 * The token is printed once, on stdout and nowhere else — only its hash is stored, so
 * a lost token is replaced rather than recovered. Everything else this prints goes to
 * stderr, which is what makes `TOKEN=$(pnpm --silent token:create pixel)` work.
 */
import { TokenStore } from '../tokens.js';
import { failWith, oneName, resolveDbPath } from './common.js';

const fail = failWith('token:create');
const name = oneName(fail, 'usage: token:create <name>');
const dbPath = resolveDbPath(fail);

// Creates the database if this runs before the server's first start, which is the
// order an operator setting up a fresh install would naturally take.
const tokens = new TokenStore(dbPath);
try {
  const token = tokens.create(name);

  console.error(`Token "${name}" created in ${dbPath}. It is shown once:`);
  console.log(token);
  console.error('Store it now; only its hash was written down.');
} catch (error) {
  fail((error as Error).message);
} finally {
  tokens.close();
}

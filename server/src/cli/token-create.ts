/**
 * Mint a token that may publish to and subscribe from this server.
 *
 *     pnpm token:create pixel
 *
 * The token is printed once, on stdout and nowhere else — only its hash is stored, so
 * a lost token is replaced rather than recovered. Everything else this prints goes to
 * stderr, which is what makes `TOKEN=$(pnpm --silent token:create pixel)` work.
 */
import { failWith, oneName, openTokenStore, resolveDbPath } from './common.js';

const fail = failWith('token:create');
const name = oneName(fail, 'usage: token:create <name>');
const dbPath = resolveDbPath(fail);

// Creates the database if this runs before the server's first start — but only where the
// directory holding it already exists, which under a unit that keeps the database in a
// StateDirectory it does not until the server has run once. `openTokenStore` says so.
const tokens = openTokenStore(fail, dbPath);
let failure: string | undefined;
try {
  const token = tokens.create(name);

  console.error(`Token "${name}" created in ${dbPath}. It is shown once:`);
  console.log(token);
  console.error('Store it now; only its hash was written down.');
} catch (error) {
  failure = (error as Error).message;
} finally {
  tokens.close();
}

// Reported outside the `finally`, because `fail` exits the process and an exiting process
// runs no `finally` — calling it from the `catch` would skip the `tokens.close()` above and
// leave the database open on exactly the path that reports an error, its WAL uncheckpointed
// and its sidecar stranded on disk. The sibling `token:revoke` is structured around the same
// hazard.
if (failure !== undefined) fail(failure);

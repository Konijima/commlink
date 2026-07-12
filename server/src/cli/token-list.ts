/**
 * List the tokens this server has issued.
 *
 *     pnpm token:list
 *
 * One token per line on stdout, tab-separated — id, name, and when it was minted — so
 * `pnpm --silent token:list | cut -f2` names them for a script. The headings go to
 * stderr, like every other word these commands print that is not data.
 *
 * No token and no hash is shown, because neither is stored in a form that could be:
 * a token is recoverable only from whoever it was given to.
 */
import { type Fail, failWith, openTokenStore, resolveDbPath } from './common.js';

const fail: Fail = failWith('token:list');

if (process.argv.length > 2) fail('usage: token:list');

const dbPath = resolveDbPath(fail);

/** A minting time as an ISO 8601 instant in UTC. Whole seconds, so no fraction shows. */
function minted(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().replace('.000Z', 'Z');
}

const tokens = openTokenStore(fail, dbPath);
try {
  const issued = tokens.list();

  // A fresh install authorizes nobody, which looks exactly like this. Say so, rather
  // than let an empty stdout read as a command that did not run. The suggestion carries
  // the path, so it mints into the database this command just read rather than into
  // whatever `token:create` would resolve on its own.
  if (issued.length === 0) {
    console.error(
      `No tokens in ${dbPath}. Mint one with: DB_PATH=${dbPath} token:create <name>`,
    );
  } else {
    console.error(`${issued.length} token(s) in ${dbPath}:`);
    console.error('ID\tNAME\tMINTED');
    for (const token of issued) {
      console.log(`${token.id}\t${token.name}\t${minted(token.createdAt)}`);
    }
  }
} finally {
  tokens.close();
}

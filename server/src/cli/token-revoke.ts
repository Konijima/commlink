/**
 * Revoke a token, by the name it was minted under.
 *
 *     pnpm token:revoke pixel
 *
 * The token stops working immediately: it is deleted from the database the running
 * server reads every request against. A subscriber already holding an open stream is not
 * cut off by the delete alone, because a token is checked when a connection is made
 * rather than for as long as it is held — but the subscribe routes sweep their open
 * connections and drop one whose token has gone within a keepalive interval (45s), so no
 * restart is needed. Restart the server to disconnect one instantly instead of waiting
 * the interval out.
 *
 * Revoking a name that was never minted is an error, not a no-op — a mistyped name
 * would otherwise look exactly like a token successfully revoked.
 */
import { TokenStore } from '../tokens.js';
import { failWith, oneName, resolveDbPath } from './common.js';

const fail = failWith('token:revoke');
const name = oneName(fail, 'usage: token:revoke <name>');
const dbPath = resolveDbPath(fail);

const tokens = new TokenStore(dbPath);
let revoked: boolean;
try {
  revoked = tokens.revoke(name);
} finally {
  tokens.close();
}

// Outside the `finally`, because `fail` exits the process and an exiting process runs
// no `finally` — the database would be left open on exactly the path that reports an error.
if (!revoked) fail(`no token named "${name}" in ${dbPath}`);

console.error(
  `Token "${name}" revoked from ${dbPath}. It no longer authorizes anything.`,
);
console.error(
  'An open subscriber is dropped within a keepalive interval (45s); no restart needed.',
);

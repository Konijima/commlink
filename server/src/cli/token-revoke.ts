/**
 * Revoke a token, by the name it was minted under.
 *
 *     pnpm token:revoke pixel
 *
 * The token stops working immediately: it is deleted from the database the running
 * server reads every request against. A subscriber already holding an open stream keeps
 * it until it disconnects, because a token is checked when a connection is made rather
 * than for as long as it is held; restart the server to cut one off at once.
 *
 * Revoking a name that was never minted is an error, not a no-op — a mistyped name
 * would otherwise look exactly like a token successfully revoked.
 */
import { TokenStore } from '../tokens.js';
import { DB_PATH, failWith, oneName } from './common.js';

const fail = failWith('token:revoke');
const name = oneName(fail, 'usage: token:revoke <name>');

const tokens = new TokenStore(DB_PATH);
let revoked: boolean;
try {
  revoked = tokens.revoke(name);
} finally {
  tokens.close();
}

// Outside the `finally`, because `fail` exits the process and an exiting process runs
// no `finally` — the database would be left open on exactly the path that reports an error.
if (!revoked) fail(`no token named "${name}" in ${DB_PATH}`);

console.error(
  `Token "${name}" revoked from ${DB_PATH}. It no longer authorizes anything.`,
);
console.error('An open subscriber keeps its stream until it disconnects.');

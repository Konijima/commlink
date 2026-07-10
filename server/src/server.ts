import { buildApp } from './app.js';
import { parseRetentionHours } from './retention.js';
import { MessageStore } from './store.js';
import { TokenStore } from './tokens.js';

// The server binds loopback by default; expose it through a TLS reverse proxy
// rather than binding a public interface directly (see deploy/).
const PORT = Number(process.env.PORT ?? 4500);
const HOST = process.env.HOST ?? '127.0.0.1';
const DB_PATH = process.env.DB_PATH ?? './commlink.sqlite';

let retentionHours: number;
try {
  retentionHours = parseRetentionHours(process.env.RETENTION_HOURS);
} catch (err) {
  // Refuse to start rather than run with a window that would never expire anything.
  console.error(`RETENTION_HOURS: ${(err as Error).message}`);
  process.exit(1);
}

const app = buildApp({
  store: new MessageStore(DB_PATH),
  tokens: new TokenStore(DB_PATH),
  retentionHours,
});

app
  .listen({ port: PORT, host: HOST })
  .then((address) => {
    console.log(`commlink server listening on ${address}`);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

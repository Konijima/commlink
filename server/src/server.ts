import { buildApp } from './app.js';
import { loadEnvFile } from './env.js';
import { parseHost } from './host.js';
import { buildLoggerOptions, parseLogLevel } from './logging.js';
import { parsePort } from './port.js';
import { parseRetentionHours } from './retention.js';
import { installShutdownHandlers } from './shutdown.js';
import { MessageStore } from './store.js';
import { TokenStore } from './tokens.js';

// Load a `.env` from the working directory before anything reads the environment, so a
// copied `.env.example` is picked up. A real environment variable still wins; a missing
// file is fine; a malformed one aborts, since it is config the operator meant to apply.
try {
  loadEnvFile();
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

// The server binds loopback by default; expose it through a TLS reverse proxy
// rather than binding a public interface directly (see deploy/).
let PORT: number;
try {
  PORT = parsePort(process.env.PORT);
} catch (err) {
  // Refuse to start rather than hand `listen` a NaN or an out-of-range port, which fails
  // with an opaque stack trace only after the database has already been opened.
  console.error((err as Error).message);
  process.exit(1);
}
let HOST: string;
try {
  HOST = parseHost(process.env.HOST);
} catch (err) {
  // Refuse to start rather than hand `listen` a blank host, which it reads as "every
  // interface" — silently turning the loopback default into a public bind.
  console.error((err as Error).message);
  process.exit(1);
}
const DB_PATH = process.env.DB_PATH ?? './commlink.sqlite';

let retentionHours: number;
try {
  retentionHours = parseRetentionHours(process.env.RETENTION_HOURS);
} catch (err) {
  // Refuse to start rather than run with a window that would never expire anything.
  console.error(`RETENTION_HOURS: ${(err as Error).message}`);
  process.exit(1);
}

let logger;
try {
  logger = buildLoggerOptions(parseLogLevel(process.env.LOG_LEVEL));
} catch (err) {
  // Refuse to start rather than run at a level the operator did not mean to set.
  console.error((err as Error).message);
  process.exit(1);
}

const app = buildApp({
  store: new MessageStore(DB_PATH),
  tokens: new TokenStore(DB_PATH),
  retentionHours,
  logger,
});

app
  .listen({ port: PORT, host: HOST })
  .then((address) => {
    app.log.info(`commlink server listening on ${address}`);
    // Turn a stop signal into a clean close now that there is a listening server to
    // drain: subscribers are told to go away rather than having their sockets severed.
    // The shutdown lines go through the same logger, so a stop is recorded in the same
    // structured stream as everything else.
    installShutdownHandlers(app, { log: (message) => app.log.info(message) });
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });

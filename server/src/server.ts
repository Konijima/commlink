import { buildApp } from './app';
import { MessageStore } from './store';

// The server binds loopback by default; expose it through a TLS reverse proxy
// rather than binding a public interface directly (see deploy/).
const PORT = Number(process.env.PORT ?? 4500);
const HOST = process.env.HOST ?? '127.0.0.1';
const DB_PATH = process.env.DB_PATH ?? './commlink.sqlite';

const app = buildApp({ store: new MessageStore(DB_PATH) });

app
  .listen({ port: PORT, host: HOST })
  .then((address) => {
    console.log(`commlink server listening on ${address}`);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

import { buildApp } from './app';

// The server binds loopback by default; expose it through a TLS reverse proxy
// rather than binding a public interface directly (see deploy/).
const PORT = Number(process.env.PORT ?? 4500);
const HOST = process.env.HOST ?? '127.0.0.1';

const app = buildApp();

app
  .listen({ port: PORT, host: HOST })
  .then((address) => {
    console.log(`commlink server listening on ${address}`);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

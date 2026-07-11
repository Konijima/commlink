import { type Socket, connect } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Broker } from '../src/broker.js';
import type { TokenStore } from '../src/tokens.js';
import { buildTestApp } from './helpers.js';

/**
 * `HEAD /:topic/json`.
 *
 * The stream route is declared as a `GET`, and Fastify exposes a `HEAD` for every `GET`
 * by default — running the same handler. That handler hijacks the socket and writes a
 * response that never ends, which is right for a stream and wrong for a `HEAD`: Node
 * sends no body for one, so nothing the handler writes ever reaches the client, and the
 * response it leaves open wedges the connection for every request behind it.
 *
 * These tests drive a raw socket rather than `fetch`, because both symptoms live in the
 * connection: `fetch` resolves a `HEAD` as soon as the headers land and then discards
 * the socket, which hides a response that never completed.
 */
describe('HEAD /:topic/json', () => {
  let app: FastifyInstance;
  let broker: Broker;
  let port: number;
  let tokens: TokenStore;
  let token: string;
  let sockets: Socket[];

  beforeEach(async () => {
    broker = new Broker();
    ({ app, tokens, token } = buildTestApp({ broker }));
    sockets = [];

    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as { port: number }).port;
  });

  afterEach(async () => {
    for (const socket of sockets) socket.destroy();
    await app.close();
    tokens.close();
  });

  /** A keep-alive connection, and everything the server has written back on it. */
  function open(): { send: (request: string) => void; received: () => string } {
    const socket = connect(port, '127.0.0.1');
    sockets.push(socket);
    socket.setEncoding('utf8');

    let received = '';
    socket.on('data', (chunk: string) => {
      received += chunk;
    });
    // A connection the test destroys in `afterEach` errors rather than closing politely.
    socket.on('error', () => {});

    return {
      send: (request: string) => socket.write(request),
      received: () => received,
    };
  }

  /** The request line and headers of a request on `path`, with the bearer token. */
  function request(method: string, path: string): string {
    return [
      `${method} ${path} HTTP/1.1`,
      'host: 127.0.0.1',
      `authorization: Bearer ${token}`,
      '',
      '',
    ].join('\r\n');
  }

  /** Wait for `text` to arrive on the connection, failing rather than hanging. */
  async function waitFor(
    connection: { received: () => string },
    text: string,
  ): Promise<void> {
    await vi.waitFor(() => expect(connection.received()).toContain(text), {
      timeout: 2000,
      interval: 10,
    });
  }

  it('answers with the headers the stream would send, and no body', async () => {
    const connection = open();

    connection.send(request('HEAD', '/alpha/json'));

    await waitFor(connection, '\r\n\r\n');
    const received = connection.received();
    expect(received).toContain('HTTP/1.1 200 OK');
    expect(received.toLowerCase()).toContain('content-type: application/x-ndjson');
    // A `HEAD` carries no content, so the reply is the headers and nothing else.
    expect(received.split('\r\n\r\n')[1]).toBe('');
  });

  it('completes the response, so the next request on the connection is answered', async () => {
    // The symptom of a hijacked response that never ends: Node writes responses on a
    // connection in order, so everything behind it waits forever. A client that pools
    // connections — an HTTP agent with `keepAlive`, a proxy with an upstream pool, a
    // monitoring probe that reuses its socket — is wedged by a single `curl -I`.
    const connection = open();

    connection.send(request('HEAD', '/alpha/json'));
    await waitFor(connection, 'HTTP/1.1 200 OK');

    connection.send(request('GET', '/healthz'));

    await waitFor(connection, '"status":"ok"');
  });

  it('subscribes nobody, so a HEAD leaves no listener behind', async () => {
    // The handler subscribes the response to the broker before it would stream. Nothing
    // can ever be delivered to a `HEAD` — Node drops every write — and nothing detaches
    // it either: the keepalive sweep only drops a reader whose backlog grows, and a
    // response that discards its writes never buffers a byte. The listener would outlive
    // every sweep, for as long as the connection stayed open.
    const connection = open();

    connection.send(request('HEAD', '/alpha/json'));
    await waitFor(connection, 'HTTP/1.1 200 OK');

    expect(broker.listenerCount('alpha')).toBe(0);
  });

  it('refuses a topic the stream would refuse', async () => {
    const connection = open();

    connection.send(request('HEAD', '/bad.topic/json'));

    await waitFor(connection, 'HTTP/1.1 400 Bad Request');
    // The reason rides on `error` for a `GET`; a `HEAD` has no body to carry it, so the
    // status is all a client gets — which is what asking for the headers alone buys.
    expect(connection.received().split('\r\n\r\n')[1]).toBe('');
  });
});

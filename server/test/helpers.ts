import type { FastifyInstance } from 'fastify';
import { type AppOptions, buildApp } from '../src/app.js';
import { TokenStore } from '../src/tokens.js';

export interface TestApp {
  app: FastifyInstance;
  /** The token store the app authenticates against. The caller closes it. */
  tokens: TokenStore;
  /** A token the app accepts. */
  token: string;
}

/**
 * Build an app that already has one valid token, since every route but `/healthz`
 * refuses a request without one. Tests about auth itself build their own instead.
 */
export function buildTestApp(options: Omit<AppOptions, 'tokens'> = {}): TestApp {
  const tokens = new TokenStore();
  const token = tokens.create('test');

  return { app: buildApp({ ...options, tokens }), tokens, token };
}

/** The `Authorization` header carrying `token`. */
export function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

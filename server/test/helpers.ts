import type { FastifyInstance } from 'fastify';
import { type AppOptions, buildApp } from '../src/app.js';
import { TokenStore } from '../src/tokens.js';

/**
 * How long a test that runs the server or a token command as its own process may take.
 *
 * Vitest's default is 5s, which is a budget for work done *in* the test process. These
 * tests spawn Node, which loads `tsx` and compiles the TypeScript entrypoint before a
 * line of the code under test runs — seconds of work on an idle machine, and several
 * seconds more when the whole suite is running and every core is already busy. Measured
 * under a full run, the slowest of them takes over 8s; a handful of others sit just the
 * wrong side of 5s. They were riding the default, so the suite went red at random on a
 * change that touched none of them.
 *
 * A timeout has to fit the work it bounds rather than the idle machine it was written on,
 * so these get one sized for a process spawn under load. It still bounds them: a command
 * that genuinely hangs fails here, it just takes 30s to say so instead of failing a
 * command that was merely slow.
 */
export const SUBPROCESS_TIMEOUT_MS = 30_000;

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

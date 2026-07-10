import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * How many publishes one token may make per {@link RATE_LIMIT_WINDOW_MS}.
 *
 * A publisher is a program announcing events — a deploy finished, a disk filled — and
 * one a second sustained is already far more than a phone should be asked to render as
 * notifications. The cap is there so a runaway loop on one machine costs that token its
 * own throughput rather than the server's memory and every subscriber's attention.
 */
export const PUBLISH_RATE_LIMIT = 60;

/** The span the limit is counted over. */
export const RATE_LIMIT_WINDOW_MS = 60_000;

/** What the server tells a client that has spent its budget. */
export const RATE_LIMIT_RULE = 'publish rate limit exceeded';

/** What the limiter refuses to be built with. */
export const RATE_LIMIT_CONFIG_RULE = 'rate limit and window must be positive integers';

/**
 * A sliding-window rate limiter, keyed by token.
 *
 * It remembers when each token's recent requests arrived and refuses the one that would
 * make more than `limit` of them fall inside the trailing window. A fixed window would
 * be cheaper, but it lets a client spend its whole budget at the end of one window and
 * again at the start of the next — twice the limit, back to back, which is exactly the
 * burst the cap exists to prevent.
 *
 * Memory is bounded: a token holds at most `limit` timestamps, because a request past
 * the limit is refused rather than recorded, and only tokens that have published are
 * held at all.
 */
export class RateLimiter {
  readonly #limit: number;
  readonly #windowMs: number;
  /** Per token, the timestamps of its requests still inside the window, oldest first. */
  readonly #hits = new Map<number, number[]>();

  constructor(limit: number = PUBLISH_RATE_LIMIT, windowMs: number = RATE_LIMIT_WINDOW_MS) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError(RATE_LIMIT_CONFIG_RULE);
    if (!Number.isSafeInteger(windowMs) || windowMs < 1) {
      throw new RangeError(RATE_LIMIT_CONFIG_RULE);
    }

    this.#limit = limit;
    this.#windowMs = windowMs;
  }

  /**
   * Charge one request to `key`.
   *
   * Returns `null` when the request is within budget — and only then is it recorded, so
   * a refused request does not push the token's next chance further away. Otherwise it
   * returns the whole seconds after which the oldest recorded request leaves the window
   * and a slot frees, which is what the caller sends as `Retry-After`.
   *
   * `now` is injectable so the window can be tested without waiting for it.
   */
  take(key: number, now: number = Date.now()): number | null {
    // A hit exactly `windowMs` old has just left the window.
    const cutoff = now - this.#windowMs;
    const hits = (this.#hits.get(key) ?? []).filter((at) => at > cutoff);
    this.#hits.set(key, hits);

    if (hits.length >= this.#limit) {
      return Math.ceil((hits[0] + this.#windowMs - now) / 1000);
    }

    hits.push(now);
    return null;
  }
}

/**
 * A `preHandler` that spends one of the request token's publish slots, and answers a
 * client with none left with `429` and a `Retry-After`.
 *
 * It runs as a `preHandler`, after the `preValidation` hook that authenticates: the
 * budget belongs to a token, so there has to be one. A request that arrives here
 * without having authenticated is a wiring mistake, and fails loudly as one — quietly
 * exempting it from the limit is the one thing a rate limiter must never do.
 */
export function publishRateLimit(limiter: RateLimiter) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | void> => {
    const { tokenId } = request;
    if (tokenId === undefined) {
      throw new Error('the publish rate limiter ran before the request was authenticated');
    }

    const retryAfter = limiter.take(tokenId);
    if (retryAfter === null) return;

    return reply
      .code(429)
      .header('retry-after', String(retryAfter))
      .send({ error: RATE_LIMIT_RULE });
  };
}

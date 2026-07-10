import type { FastifyInstance } from 'fastify';
import { everyInterval } from './keepalive.js';
import type { MessageStore } from './store.js';

/**
 * How long a published message stays in the cache, in hours.
 *
 * Three days covers a phone that was off, flat or out of signal over a long weekend,
 * which is the longest gap a subscriber is expected to catch up from. Past that the
 * message is stale enough that delivering it is worse than dropping it.
 */
export const RETENTION_HOURS = 72;

/** How often expired messages are swept out of the database. */
export const RETENTION_SWEEP_INTERVAL_MS = 3_600_000;

const SECONDS_PER_HOUR = 3_600;

/** What the server tells an operator who configured a retention window it cannot use. */
export const RETENTION_RULE = 'retention must be a whole number of hours, at least 1';

/**
 * Parse `RETENTION_HOURS` from the environment. Absent means {@link RETENTION_HOURS}.
 *
 * Throws a `RangeError` naming the rule for anything else. A window that silently fell
 * back to a default — or worse, to `NaN`, which no message is ever older than — would
 * leave the database growing exactly as it does with no retention at all.
 */
export function parseRetentionHours(raw: string | undefined): number {
  if (raw === undefined) return RETENTION_HOURS;

  const trimmed = raw.trim();
  // Digits only, as `parseSince` does: `Number` alone would take `1e3`, `0x10` and ` `.
  if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(Number(trimmed))) {
    throw new RangeError(RETENTION_RULE);
  }

  const hours = Number(trimmed);
  if (hours < 1) throw new RangeError(RETENTION_RULE);

  return hours;
}

export interface RetentionOptions {
  /** How long a message stays replayable. Defaults to {@link RETENTION_HOURS}. */
  retentionHours?: number;
  /** How often the sweep runs. Defaults to {@link RETENTION_SWEEP_INTERVAL_MS}. */
  sweepIntervalMs?: number;
}

/**
 * Keep `store` bounded: delete messages older than the retention window as `app` comes
 * up, and once per interval for as long as it stays up.
 *
 * The sweep runs at startup as well as on the interval because a server restarted more
 * often than the interval would otherwise never reach its first tick, and a long-dead
 * server would come back holding whatever expired while it was down.
 */
export function registerRetention(
  app: FastifyInstance,
  store: MessageStore,
  options: RetentionOptions = {},
): void {
  const hours = options.retentionHours ?? RETENTION_HOURS;
  if (!Number.isSafeInteger(hours) || hours < 1) throw new RangeError(RETENTION_RULE);

  const sweep = (): void => {
    store.prune(Math.floor(Date.now() / 1000) - hours * SECONDS_PER_HOUR);
  };

  app.addHook('onReady', async () => sweep());
  everyInterval(app, options.sweepIntervalMs ?? RETENTION_SWEEP_INTERVAL_MS, sweep);
}

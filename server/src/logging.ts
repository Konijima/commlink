import type { FastifyRequest, FastifyServerOptions } from 'fastify';

/**
 * The pino levels the server accepts for `LOG_LEVEL`, quietest to loudest, with `silent`
 * turning logging off entirely. Anything else is a value the operator meant as a level but
 * mistyped, so it is refused rather than run past — the same stance `RETENTION_HOURS` takes.
 */
export const LOG_LEVELS = [
  'trace',
  'debug',
  'info',
  'warn',
  'error',
  'fatal',
  'silent',
] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

/** The default level when `LOG_LEVEL` is unset: request lines and above, no debug noise. */
export const DEFAULT_LOG_LEVEL: LogLevel = 'info';

/** What the server tells an operator whose `LOG_LEVEL` is not one it knows. */
export function logLevelRule(): string {
  return `LOG_LEVEL must be one of: ${LOG_LEVELS.join(', ')}`;
}

function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

/**
 * Resolve `LOG_LEVEL` to a pino level. An unset or empty value is {@link DEFAULT_LOG_LEVEL};
 * a known level (case-insensitive, so `INFO` works) is taken as given; anything else throws,
 * so a typo'd level surfaces at boot rather than silently leaving logging where it was.
 */
export function parseLogLevel(raw: string | undefined): LogLevel {
  if (raw === undefined || raw.trim() === '') return DEFAULT_LOG_LEVEL;
  const level = raw.trim().toLowerCase();
  if (isLogLevel(level)) return level;
  throw new Error(logLevelRule());
}

/**
 * Mask the value of any `auth` query parameter in a URL.
 *
 * A browser cannot set a header on a WebSocket handshake, so the subscribe routes accept
 * the bearer token as `?auth=<token>`. That token is a secret, and pino's request log
 * records `req.url` — which is where the query string lives. Left alone, every subscribe
 * would write the token to the log in clear. This replaces only the value, so the rest of
 * the URL (the topic list, `?since=`) is logged exactly as it arrived.
 */
export function redactAuthInUrl(url: string): string {
  return url.replace(/([?&]auth=)[^&]*/gi, '$1[REDACTED]');
}

// Mirror Fastify's own request serializer, but run the URL through the redactor first so a
// subscribe token never reaches the log. Kept in step with Fastify's default fields; the
// only change is the redacted URL.
function serializeRequest(request: FastifyRequest): Record<string, unknown> {
  return {
    method: request.method,
    url: redactAuthInUrl(request.url),
    host: request.host,
    remoteAddress: request.ip,
    remotePort: request.socket?.remotePort,
  };
}

/**
 * Build the Fastify logger configuration for a resolved level.
 *
 * `stream` is injected by the logging test so it can read back exactly what was written and
 * prove the redaction holds; production leaves it undefined and pino writes to stdout.
 */
export function buildLoggerOptions(
  level: LogLevel,
  stream?: NodeJS.WritableStream,
): FastifyServerOptions['logger'] {
  return {
    level,
    serializers: { req: serializeRequest },
    ...(stream ? { stream } : {}),
  };
}

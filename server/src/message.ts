import { randomUUID } from 'node:crypto';

/** A published message, as stored and as streamed to subscribers. */
export interface Message {
  id: string;
  topic: string;
  title: string | null;
  message: string;
  priority: number;
  tags: string[];
  /** Publication time, in whole seconds since the Unix epoch. */
  timestamp: number;
}

export const MIN_PRIORITY = 1;
export const MAX_PRIORITY = 5;
export const DEFAULT_PRIORITY = 3;

/** Topic names travel in URL paths, so keep them to an unambiguous alphabet. */
const TOPIC_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Paths the server serves itself; they can never be topic names. */
const RESERVED_TOPICS = new Set(['healthz']);

/** What every route tells a client that named a topic the server will not serve. */
export const TOPIC_RULE =
  'topic must be 1-64 characters of A-Z, a-z, 0-9, hyphen or underscore';

export function isValidTopic(topic: string): boolean {
  return TOPIC_PATTERN.test(topic) && !RESERVED_TOPICS.has(topic);
}

/**
 * Node exposes a repeated header as an array. Take the first value rather than
 * joining, so a duplicated `X-Title` cannot smuggle a comma-joined title through.
 */
export function headerValue(raw: string | string[] | undefined): string | undefined {
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

/** Parse `X-Priority`. Absent means the default; anything but 1–5 is an error. */
export function parsePriority(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_PRIORITY;

  const trimmed = raw.trim();
  if (!/^[1-5]$/.test(trimmed)) {
    throw new RangeError(`priority must be an integer ${MIN_PRIORITY}-${MAX_PRIORITY}`);
  }

  return Number(trimmed);
}

/** Parse `X-Tags`: comma-separated, surrounding space ignored, empties dropped. */
export function parseTags(raw: string | undefined): string[] {
  if (raw === undefined) return [];

  return raw
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

/** Parse `X-Title`. A blank title is the same as no title at all. */
export function parseTitle(raw: string | undefined): string | null {
  if (raw === undefined) return null;

  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function createMessage(fields: {
  topic: string;
  message: string;
  title: string | null;
  priority: number;
  tags: string[];
}): Message {
  return {
    id: randomUUID(),
    topic: fields.topic,
    title: fields.title,
    message: fields.message,
    priority: fields.priority,
    tags: fields.tags,
    timestamp: Math.floor(Date.now() / 1000),
  };
}

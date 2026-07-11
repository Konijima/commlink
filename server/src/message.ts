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

/**
 * What publish tells a client whose `X-Priority` is not `1`–`5`. Named after the header
 * the client set, like `TITLE_RULE` and `TAGS_RULE`, so a `400` read off `error` says
 * which header to fix rather than leaving the client to infer that "priority" means the
 * `X-Priority` it sent.
 */
export const PRIORITY_RULE = `X-Priority must be an integer ${MIN_PRIORITY}-${MAX_PRIORITY}`;

export const MAX_TOPIC_LENGTH = 64;

/** Topic names travel in URL paths, so keep them to an unambiguous alphabet. */
const TOPIC_PATTERN = new RegExp(`^[A-Za-z0-9_-]{1,${MAX_TOPIC_LENGTH}}$`);

/** Paths the server serves itself; they can never be topic names. */
const RESERVED_TOPICS = new Set(['healthz']);

/** What a route tells a client whose topic name breaks the alphabet or length rule. */
export const TOPIC_RULE = `topic must be 1-${MAX_TOPIC_LENGTH} characters of A-Z, a-z, 0-9, hyphen or underscore`;

/**
 * What a route tells a client that named a topic the server keeps for itself — one that
 * satisfies the alphabet but collides with a path the server serves. It is named as
 * reserved rather than blamed on the alphabet it does not break, so a client is not told
 * to fix a rule its name already keeps.
 */
export function reservedTopicRule(topic: string): string {
  return `topic "${topic}" is reserved by the server`;
}

/**
 * The largest publish body the server will read, in bytes.
 *
 * A message becomes a notification on a phone's lock screen, where a few hundred
 * characters is already more than anyone reads. The limit is generous against that and
 * still small enough that the body of a request the server has not yet authenticated
 * cannot cost it anything worth counting.
 */
export const MAX_BODY_BYTES = 4096;

/**
 * What the server tells a client whose publish body is over the limit — which the app
 * may have been built with a different one of, so it is named rather than assumed.
 */
export function bodyRule(maxBytes: number = MAX_BODY_BYTES): string {
  return `message body must be at most ${maxBytes} bytes`;
}

/** What publish tells a client whose message body is not UTF-8. */
export const BODY_ENCODING_RULE = 'message body must be valid UTF-8';

/**
 * What the server tells a client whose request URL is not a valid URL — a path with a
 * malformed percent-escape, say. The router refuses it before any route runs, so this is
 * the reason a client reads off `error` rather than the framework's default
 * `{ error, code, message }` body.
 */
export const MALFORMED_URL_RULE = 'request URL is not a valid URL';

/**
 * The largest `X-Title` accepted, in bytes.
 *
 * A title is the one line a notification shows before it is opened; a limit this size
 * is past what any lock screen renders. Node caps the whole header block at 16 KiB, so
 * without a rule of its own a title could be nearly that long — refused for a body,
 * accepted for the line above it.
 */
export const MAX_TITLE_BYTES = 256;

/** What publish tells a client whose `X-Title` is over the limit. */
export const TITLE_RULE = `X-Title must be at most ${MAX_TITLE_BYTES} bytes`;

/** How many tags one message may carry, and how long each may be, in bytes. */
export const MAX_TAGS = 16;
export const MAX_TAG_BYTES = 64;

/** What publish tells a client whose `X-Tags` is over either limit. */
export const TAGS_RULE = `X-Tags must be at most ${MAX_TAGS} tags of at most ${MAX_TAG_BYTES} bytes each`;

/** What publish tells a client whose metadata headers are not UTF-8. */
export const TITLE_ENCODING_RULE = 'X-Title must be valid UTF-8';
export const TAGS_ENCODING_RULE = 'X-Tags must be valid UTF-8';

/**
 * Text headers are UTF-8 on the wire, undeclared: a client sends the bytes of the title
 * it wants shown, and `curl -H "X-Title: Café"` from any modern shell already does. The
 * alternative — RFC 2047 encoded words — would make every client, and every `curl` one
 * liner, encode a title the server could just as well read. Anything else is refused
 * rather than guessed at: a lone `0xE9` is `é` in latin1, half a character in UTF-8, and
 * a server that picks for the client silently delivers the wrong title.
 */
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * Recover the bytes a header arrived as, and read them as UTF-8.
 *
 * Node decodes header values as latin1 — one character per byte received — so a UTF-8
 * title arrives spelled as its own bytes, and is stored and streamed as mojibake unless
 * it is decoded back. Re-encoding as latin1 recovers those bytes exactly, because every
 * byte has a latin1 character and no other.
 *
 * Throws a `RangeError` naming `rule` if the bytes are not UTF-8. Decoding is therefore
 * lossless, and `headerBytes` can count the result back to what the client sent.
 */
function decodeHeader(value: string, rule: string): string {
  try {
    return UTF8.decode(Buffer.from(value, 'latin1'));
  } catch {
    throw new RangeError(rule);
  }
}

/**
 * Read a publish body from the bytes it arrived as.
 *
 * The body is the message text a subscriber is shown, and like `X-Title` it is UTF-8 on
 * the wire — a client sends the bytes it wants delivered. Node's `Buffer#toString('utf8')`
 * would map an invalid sequence to U+FFFD and hand on the replacement silently, the same
 * corruption `decodeHeader` refuses for a title: the body is the message itself, so a
 * server that mangles it delivers the wrong notification without saying so. The bytes are
 * decoded strictly instead, and anything that is not UTF-8 is refused.
 *
 * Throws a `RangeError` naming {@link BODY_ENCODING_RULE} if the bytes are not UTF-8.
 */
export function decodeBody(body: Buffer): string {
  try {
    return UTF8.decode(body);
  } catch {
    throw new RangeError(BODY_ENCODING_RULE);
  }
}

/**
 * How many bytes a decoded header value took on the wire.
 *
 * `decodeHeader` reverses Node's latin1 decoding and refuses anything that was not
 * UTF-8, so re-encoding what it returns yields the client's own bytes back, and counting
 * those is counting the wire.
 */
function headerBytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/**
 * How many topics one connection may multiplex. The limit keeps a single client from
 * pinning an unbounded subscription set — and the URL that names it — on the server.
 */
export const MAX_SUBSCRIBE_TOPICS = 50;

/** What a subscribe route tells a client that asked for more topics than allowed. */
export const TOPIC_LIST_RULE = `subscribe to at most ${MAX_SUBSCRIBE_TOPICS} comma-separated topics`;

/**
 * The longest topic segment the routes can ever accept: every topic at full length,
 * separated by commas. The router needs this to size its own path-parameter limit,
 * which would otherwise truncate a legal list into a `414` before any route sees it.
 */
export const MAX_TOPIC_LIST_LENGTH = MAX_SUBSCRIBE_TOPICS * (MAX_TOPIC_LENGTH + 1) - 1;

/**
 * What the server tells a client whose topic segment overruns {@link MAX_TOPIC_LIST_LENGTH}
 * — a URL too long for even the largest legal list to fit in. The router caps the path
 * parameter at that length and refuses a longer one with a `414` before any route runs, so
 * the friendlier per-rule refusals never get to speak. The overrun is one of two things —
 * more than {@link MAX_SUBSCRIBE_TOPICS} topics, or a single name past {@link MAX_TOPIC_LENGTH}
 * — and this names both bounds so a client learns the reason off `error` like every other
 * refusal, rather than reading the framework's default `{ error, code, message }` shape.
 */
export const TOPIC_LIST_TOO_LONG_RULE = `subscribe to at most ${MAX_SUBSCRIBE_TOPICS} topics of at most ${MAX_TOPIC_LENGTH} characters each`;

/**
 * Why the server will not accept `topic`, or `null` if it will. A name outside the topic
 * alphabet or length breaks `TOPIC_RULE`; a name inside it that the server serves itself
 * is reserved, and told so by `reservedTopicRule` rather than misattributed to the
 * alphabet. The alphabet is checked first, so an over-long name never reaches — and so
 * never gets echoed by — the reserved message.
 */
export function topicRefusal(topic: string): string | null {
  if (!TOPIC_PATTERN.test(topic)) return TOPIC_RULE;
  if (RESERVED_TOPICS.has(topic)) return reservedTopicRule(topic);
  return null;
}

/**
 * Parse the topic segment of a subscribe route: one topic name, or several separated
 * by commas. Repeats collapse, so the result names each topic once, in the order the
 * client first asked for it.
 *
 * Throws a `RangeError` naming the broken rule if the list is over-long or any entry
 * is not a topic this server serves. Both subscribe routes report that message back.
 */
export function parseTopicList(raw: string): string[] {
  const names = raw.split(',');
  if (names.length > MAX_SUBSCRIBE_TOPICS) {
    throw new RangeError(TOPIC_LIST_RULE);
  }

  const topics: string[] = [];
  for (const name of names) {
    const refusal = topicRefusal(name);
    if (refusal !== null) {
      throw new RangeError(refusal);
    }
    if (!topics.includes(name)) topics.push(name);
  }

  return topics;
}

/**
 * The single value of something a client may have sent more than once.
 *
 * Fastify hands over a repeated query parameter — `?since=1&since=2` — as an array, and
 * this takes the first: a client that asked twice gets the answer to its first question
 * rather than a `400` about `"1,2"`.
 *
 * A repeated *header* never arrives as an array here. Node folds one before a route sees
 * it, and which way depends on the header: `Authorization` and `Content-Type` keep the
 * first and discard the rest, while a header of our own — `X-Title`, `X-Tags`,
 * `X-Priority` — is joined with `", "`. (Only `Set-Cookie`, which a request has no
 * business carrying, becomes an array.) So a duplicated `X-Title` is delivered as
 * `"alpha, beta"`, and it is that joined value the size limit is measured against — a
 * repeat buys no extra room. A duplicated `X-Priority` folds into `"1, 5"`, which is not
 * an integer, and is refused. `test/repeatedheaders.test.ts` pins all of it.
 */
export function headerValue(raw: string | string[] | undefined): string | undefined {
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

/** What a subscribe route tells a client that asked to replay from a bad timestamp. */
export const SINCE_RULE = 'since must be a whole number of seconds since the Unix epoch';

/**
 * Parse `?since=` on a subscribe route: the timestamp to replay the backlog from,
 * in seconds since the Unix epoch. Absent means no replay — the subscriber sees only
 * what is published from now on.
 *
 * Throws a `RangeError` naming the rule for anything that is not a non-negative whole
 * number, including an empty `?since=`: a client that meant to replay everything says
 * so with `?since=0`, and one that sent a broken timestamp should hear about it rather
 * than silently lose its backlog.
 */
export function parseSince(raw: string | string[] | undefined): number | null {
  const value = headerValue(raw);
  if (value === undefined) return null;

  const trimmed = value.trim();
  // Digits only: `parseInt` would take `12abc`, and `Number` would take `1e3`, ` `,
  // `0x10` and `-0`. The safe-integer bound then rejects a timestamp so far in the
  // future that it could not survive the round trip through a double.
  if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(Number(trimmed))) {
    throw new RangeError(SINCE_RULE);
  }

  return Number(trimmed);
}

/** Parse `X-Priority`. Absent means the default; anything but 1–5 is an error. */
export function parsePriority(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_PRIORITY;

  const trimmed = raw.trim();
  if (!/^[1-5]$/.test(trimmed)) {
    throw new RangeError(PRIORITY_RULE);
  }

  return Number(trimmed);
}

/**
 * Parse `X-Tags`: comma-separated, surrounding space ignored, empties dropped.
 *
 * Throws a `RangeError` naming the rule for a value that is not UTF-8, for too many
 * tags, or for one that is too long. The two bounds are measured after the empties are
 * dropped and the space is trimmed, so what is bounded is what a subscriber will be sent.
 */
export function parseTags(raw: string | undefined): string[] {
  if (raw === undefined) return [];

  // Decoded whole, before the split: a comma is one byte in UTF-8 and never part of
  // another character, so the tags it separates are the same either way — but `trim`
  // run on the undecoded value would strip `0xA0`, a byte that is a no-break space in
  // latin1 and the tail of `à` in UTF-8.
  const tags = decodeHeader(raw, TAGS_ENCODING_RULE)
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);

  if (tags.length > MAX_TAGS) throw new RangeError(TAGS_RULE);
  if (tags.some((tag) => headerBytes(tag) > MAX_TAG_BYTES))
    throw new RangeError(TAGS_RULE);

  return tags;
}

/**
 * Parse `X-Title`. A blank title is the same as no title at all.
 *
 * Throws a `RangeError` naming the rule for a value that is not UTF-8, or for an
 * over-long one — rather than truncating, since half a title is not what the sender
 * asked to be shown. The bound is on the value as sent, so padding a long title with
 * space does not buy it room.
 */
export function parseTitle(raw: string | undefined): string | null {
  if (raw === undefined) return null;

  // Decoded before it is measured, and before it is trimmed: the byte count is the same
  // either way, but a title ending in `à` loses its last byte to `trim` otherwise.
  const title = decodeHeader(raw, TITLE_ENCODING_RULE);
  if (headerBytes(title) > MAX_TITLE_BYTES) throw new RangeError(TITLE_RULE);

  const trimmed = title.trim();
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

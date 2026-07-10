import type Database from 'better-sqlite3';
import { IN_MEMORY, openDatabase } from './db.js';
import type { Message } from './message.js';

/**
 * One row of the `messages` table. SQLite has no boolean, array or null-vs-undefined
 * distinction to lean on, so tags travel as JSON text and an absent title as `NULL`.
 */
interface MessageRow {
  id: string;
  topic: string;
  title: string | null;
  message: string;
  priority: number;
  tags: string;
  timestamp: number;
}

/** The bound parameters of the insert, in column order. */
type AppendParams = [
  id: string,
  topic: string,
  title: string | null,
  message: string,
  priority: number,
  tags: string,
  timestamp: number,
];

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS messages (
    seq       INTEGER PRIMARY KEY AUTOINCREMENT,
    id        TEXT    NOT NULL UNIQUE,
    topic     TEXT    NOT NULL,
    title     TEXT,
    message   TEXT    NOT NULL,
    priority  INTEGER NOT NULL,
    tags      TEXT    NOT NULL,
    timestamp INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS messages_topic_timestamp
    ON messages (topic, timestamp);
`;

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    topic: row.topic,
    title: row.title,
    message: row.message,
    priority: row.priority,
    tags: JSON.parse(row.tags) as string[],
    timestamp: row.timestamp,
  };
}

/**
 * Every published message, on disk.
 *
 * The broker fans a message out to whoever is connected at the time; this is what
 * makes it survive the moment. A subscriber that was offline — or that reconnects
 * after a dropped socket — catches up by asking for everything since the last
 * message it saw.
 *
 * Writes are synchronous. A publish is not acknowledged until its message is in the
 * database, so a message the server has answered `200` for is one a later `since()`
 * will return.
 */
export class MessageStore {
  readonly #db: Database.Database;
  readonly #append: Database.Statement<AppendParams>;
  readonly #prune: Database.Statement<[cutoff: number]>;

  /**
   * Open (and create, if needed) the database at `path`. Pass {@link IN_MEMORY} for a
   * throwaway database — the default, so that a store nobody configured cannot quietly
   * scatter files across a working directory.
   */
  constructor(path: string = IN_MEMORY) {
    this.#db = openDatabase(path);
    this.#db.exec(SCHEMA);

    this.#append = this.#db.prepare(
      `INSERT INTO messages (id, topic, title, message, priority, tags, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    this.#prune = this.#db.prepare(`DELETE FROM messages WHERE timestamp < ?`);
  }

  /** Store `message`. Throws if its id is already present. */
  append(message: Message): void {
    this.#append.run(
      message.id,
      message.topic,
      message.title,
      message.message,
      message.priority,
      JSON.stringify(message.tags),
      message.timestamp,
    );
  }

  /**
   * Every stored message on any of `topics` published at or after `timestamp`, oldest
   * first.
   *
   * The bound is inclusive because a timestamp only resolves to the second: a client
   * that asks for everything since the last message it saw would otherwise lose any
   * message published during that same second. Two messages can therefore arrive
   * twice across a reconnect, so clients de-duplicate on `id`.
   *
   * Ordering is by insertion, not by timestamp, for the same reason — messages sharing
   * a second still replay in the order they were published.
   *
   * Only what is still inside the retention window can come back; see {@link prune}.
   */
  since(topics: readonly string[], timestamp: number): Message[] {
    if (topics.length === 0) return [];

    const placeholders = topics.map(() => '?').join(', ');
    const rows = this.#db
      .prepare(
        `SELECT id, topic, title, message, priority, tags, timestamp
           FROM messages
          WHERE topic IN (${placeholders}) AND timestamp >= ?
          ORDER BY seq`,
      )
      .all(...topics, timestamp) as MessageRow[];

    return rows.map(toMessage);
  }

  /**
   * Delete every message published before `cutoff`, across all topics, and report how
   * many were removed.
   *
   * The bound is exclusive where {@link since}'s is inclusive, so the two agree on the
   * edge: a message stamped exactly `cutoff` is still replayable rather than swept a
   * second early.
   */
  prune(cutoff: number): number {
    return this.#prune.run(cutoff).changes;
  }

  close(): void {
    this.#db.close();
  }
}

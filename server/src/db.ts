import Database from 'better-sqlite3';

/** Open a database that lives only as long as the process. */
export const IN_MEMORY = ':memory:';

/**
 * Open (and create, if needed) the SQLite database at `path`, with the settings every
 * connection the server makes should share.
 *
 * Messages and tokens live in the same file but hold a connection each: they are read
 * and written at unrelated moments, and one connection per concern keeps their
 * statements independent. `IN_MEMORY` is the exception — each such connection is its
 * own private database, which is what the tests want.
 */
export function openDatabase(path: string = IN_MEMORY): Database.Database {
  const db = new Database(path);

  // A reader replaying its backlog must not block the publish that is writing the
  // next message, and vice versa.
  db.pragma('journal_mode = WAL');
  // Fsync at checkpoints rather than on every commit. In WAL mode this can only lose
  // the tail of the last second if the machine loses power — never corrupt the file —
  // which is the right trade for notifications.
  db.pragma('synchronous = NORMAL');

  return db;
}

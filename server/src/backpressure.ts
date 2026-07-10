/**
 * How many bytes may queue for one subscriber before the server hangs up on it.
 *
 * A subscriber that stops reading does not stop the messages arriving for it. Its
 * socket's send buffer fills, and everything published after that queues in this
 * process's heap with nothing to bound it — one wedged client on a busy topic is
 * enough to grow the server until it dies. Past this mark the connection is dropped
 * instead: the server keeps its memory, and the client is free to reconnect.
 *
 * The backlog is measured before each write, so the real ceiling is this plus the
 * one message that crosses it. 1 MiB is far more slack than a subscriber on a slow
 * network ever needs, and small enough that many stalled ones together stay well
 * short of exhausting the heap.
 */
export const MAX_BUFFERED_BYTES = 1_048_576;

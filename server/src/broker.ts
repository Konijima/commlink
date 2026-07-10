import type { Message } from './message';

export type MessageListener = (message: Message) => void;

export interface BrokerOptions {
  /**
   * Called when a listener throws. Delivery to the remaining listeners continues
   * either way — one broken subscriber must not silence a topic for the others.
   */
  onListenerError?: (error: unknown, message: Message) => void;
}

/**
 * In-memory fan-out from topics to live subscribers.
 *
 * The broker only knows about connections that exist right now; durability and
 * replay are the message store's job.
 */
export class Broker {
  readonly #listeners = new Map<string, Set<MessageListener>>();
  readonly #onListenerError: BrokerOptions['onListenerError'];

  constructor(options: BrokerOptions = {}) {
    this.#onListenerError = options.onListenerError;
  }

  /**
   * Attach `listener` to every named topic. Returns an idempotent unsubscribe
   * function; a listener subscribed to a topic twice is still called once.
   */
  subscribe(topics: readonly string[], listener: MessageListener): () => void {
    for (const topic of topics) {
      let listeners = this.#listeners.get(topic);
      if (listeners === undefined) {
        listeners = new Set();
        this.#listeners.set(topic, listeners);
      }
      listeners.add(listener);
    }

    return () => {
      for (const topic of topics) {
        const listeners = this.#listeners.get(topic);
        if (listeners === undefined) continue;

        listeners.delete(listener);
        if (listeners.size === 0) this.#listeners.delete(topic);
      }
    };
  }

  /** Deliver a message to every current subscriber. Returns how many received it. */
  publish(message: Message): number {
    const listeners = this.#listeners.get(message.topic);
    if (listeners === undefined) return 0;

    let delivered = 0;

    // Copy first: a listener may unsubscribe itself while being called.
    for (const listener of [...listeners]) {
      try {
        listener(message);
        delivered += 1;
      } catch (error) {
        this.#onListenerError?.(error, message);
      }
    }

    return delivered;
  }

  /** How many listeners are currently attached to `topic`. */
  listenerCount(topic: string): number {
    return this.#listeners.get(topic)?.size ?? 0;
  }
}

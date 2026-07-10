import { describe, expect, it, vi } from 'vitest';
import { Broker } from '../src/broker';
import { createMessage } from '../src/message';
import type { Message } from '../src/message';

function message(topic: string, text = 'hello'): Message {
  return createMessage({ topic, message: text, title: null, priority: 3, tags: [] });
}

describe('Broker', () => {
  it('delivers a message to every subscriber of its topic', () => {
    const broker = new Broker();
    const first = vi.fn();
    const second = vi.fn();

    broker.subscribe(['alerts'], first);
    broker.subscribe(['alerts'], second);

    const sent = message('alerts');
    expect(broker.publish(sent)).toBe(2);
    expect(first).toHaveBeenCalledWith(sent);
    expect(second).toHaveBeenCalledWith(sent);
  });

  it('does not deliver a message to subscribers of other topics', () => {
    const broker = new Broker();
    const listener = vi.fn();

    broker.subscribe(['alerts'], listener);

    expect(broker.publish(message('builds'))).toBe(0);
    expect(listener).not.toHaveBeenCalled();
  });

  it('publishing to a topic with no subscribers delivers to nobody', () => {
    const broker = new Broker();

    expect(broker.publish(message('empty'))).toBe(0);
  });

  it('subscribes one listener to several topics at once', () => {
    const broker = new Broker();
    const listener = vi.fn();

    broker.subscribe(['alerts', 'builds'], listener);

    broker.publish(message('alerts'));
    broker.publish(message('builds'));

    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('calls a listener once per message even if it subscribed to a topic twice', () => {
    const broker = new Broker();
    const listener = vi.fn();

    broker.subscribe(['alerts', 'alerts'], listener);

    expect(broker.publish(message('alerts'))).toBe(1);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('stops delivering after unsubscribe, and forgets the topic', () => {
    const broker = new Broker();
    const listener = vi.fn();

    const unsubscribe = broker.subscribe(['alerts'], listener);
    expect(broker.listenerCount('alerts')).toBe(1);

    unsubscribe();

    expect(broker.listenerCount('alerts')).toBe(0);
    expect(broker.publish(message('alerts'))).toBe(0);
    expect(listener).not.toHaveBeenCalled();
  });

  it('unsubscribing twice is harmless', () => {
    const broker = new Broker();
    const unsubscribe = broker.subscribe(['alerts'], vi.fn());

    unsubscribe();
    expect(() => unsubscribe()).not.toThrow();
    expect(broker.listenerCount('alerts')).toBe(0);
  });

  it('leaves other subscribers attached when one unsubscribes', () => {
    const broker = new Broker();
    const staying = vi.fn();

    const unsubscribe = broker.subscribe(['alerts'], vi.fn());
    broker.subscribe(['alerts'], staying);

    unsubscribe();

    expect(broker.publish(message('alerts'))).toBe(1);
    expect(staying).toHaveBeenCalledTimes(1);
  });

  it('keeps delivering when a listener throws, and reports the error', () => {
    const onListenerError = vi.fn();
    const broker = new Broker({ onListenerError });
    const boom = new Error('subscriber exploded');
    const healthy = vi.fn();

    broker.subscribe(['alerts'], () => {
      throw boom;
    });
    broker.subscribe(['alerts'], healthy);

    const sent = message('alerts');

    expect(broker.publish(sent)).toBe(1);
    expect(healthy).toHaveBeenCalledWith(sent);
    expect(onListenerError).toHaveBeenCalledWith(boom, sent);
  });

  it('swallows a listener error when no error handler is configured', () => {
    const broker = new Broker();

    broker.subscribe(['alerts'], () => {
      throw new Error('subscriber exploded');
    });

    expect(() => broker.publish(message('alerts'))).not.toThrow();
  });

  it('allows a listener to unsubscribe itself during delivery', () => {
    const broker = new Broker();
    const later = vi.fn();

    const unsubscribe = broker.subscribe(['alerts'], () => unsubscribe());
    broker.subscribe(['alerts'], later);

    expect(() => broker.publish(message('alerts'))).not.toThrow();
    expect(later).toHaveBeenCalledTimes(1);
    expect(broker.listenerCount('alerts')).toBe(1);
  });
});

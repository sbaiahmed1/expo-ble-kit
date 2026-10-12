import type { Subscription } from '../types';

/** Minimal synchronous event emitter with Expo's `addListener` shape. */
export class Emitter<Events extends Record<string, (event: any) => void>> {
  private readonly listeners = new Map<keyof Events, Set<(event: any) => void>>();

  addListener<E extends keyof Events>(event: E, listener: Events[E]): Subscription {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener);
    this.listeners.set(event, set);
    return { remove: () => set.delete(listener) };
  }

  emit<E extends keyof Events>(event: E, payload: Parameters<Events[E]>[0]): void {
    [...(this.listeners.get(event) ?? [])].forEach((listener) => listener(payload));
  }
}

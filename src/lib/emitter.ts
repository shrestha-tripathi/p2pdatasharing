/**
 * Tiny event emitter — internal use only.
 */
export type Listener<T> = (payload: T) => void;

export function createEmitter<EventMap>() {
  const listeners: { [K in keyof EventMap]?: Set<Listener<EventMap[K]>> } = {};
  return {
    on<K extends keyof EventMap>(event: K, fn: Listener<EventMap[K]>) {
      (listeners[event] ??= new Set()).add(fn);
      return () => listeners[event]?.delete(fn);
    },
    emit<K extends keyof EventMap>(event: K, payload: EventMap[K]) {
      listeners[event]?.forEach((fn) => fn(payload));
    },
  };
}

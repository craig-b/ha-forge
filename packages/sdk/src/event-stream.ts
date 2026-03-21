import type { StateChangedEvent, EventStream } from './types.js';

/**
 * Creates an EventStream that wraps a base subscription.
 *
 * @param subscribe - Function that registers a callback and returns an unsubscribe function.
 * @param callback - Optional initial callback to invoke on each event.
 */
export function createEventStream(
  subscribe: (cb: (event: StateChangedEvent) => void) => () => void,
  callback?: (event: StateChangedEvent) => void,
): EventStream {
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  let baseUnsub: (() => void) | null = null;
  let disposed = false;

  // The actual callback that receives events — starts as the user's callback or a no-op
  let handler: (event: StateChangedEvent) => void = callback ?? (() => {});

  // Subscribe immediately
  baseUnsub = subscribe((event) => {
    if (!disposed) handler(event);
  });

  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    for (const t of timers) clearTimeout(t);
    timers.length = 0;
    baseUnsub?.();
  };

  const stream: EventStream = {
    unsubscribe: cleanup,

    filter(predicate) {
      const prev = handler;
      handler = (event) => {
        if (predicate(event)) prev(event);
      };
      return stream;
    },

    map(transform) {
      const prev = handler;
      handler = (event) => {
        prev(transform(event));
      };
      return stream;
    },

    debounce(ms) {
      const prev = handler;
      let pending: ReturnType<typeof setTimeout> | null = null;
      handler = (event) => {
        if (pending !== null) {
          clearTimeout(pending);
          const idx = timers.indexOf(pending);
          if (idx !== -1) timers.splice(idx, 1);
        }
        pending = setTimeout(() => {
          pending = null;
          prev(event);
        }, ms);
        timers.push(pending);
      };
      return stream;
    },

    throttle(ms) {
      const prev = handler;
      let lastFired = 0;
      handler = (event) => {
        const now = Date.now();
        if (now - lastFired >= ms) {
          lastFired = now;
          prev(event);
        }
      };
      return stream;
    },

    distinctUntilChanged() {
      const prev = handler;
      let lastState: string | undefined;
      handler = (event) => {
        if (event.new_state !== lastState) {
          lastState = event.new_state;
          prev(event);
        }
      };
      return stream;
    },

    transition(from, to) {
      const prev = handler;
      handler = (event) => {
        const fromMatch = from === '*' || event.old_state === from;
        const toMatch = to === '*' || event.new_state === to;
        if (fromMatch && toMatch) prev(event);
      };
      return stream;
    },
  };

  return stream;
}

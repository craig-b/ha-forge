import type { StateChangedEvent, EventStream } from './types.js';

/** A middleware that receives an event and calls next() to pass it downstream. */
type Processor = (event: StateChangedEvent, next: (event: StateChangedEvent) => void) => void;

/**
 * Creates an EventStream that wraps a base subscription.
 * Operators are applied in reading order (left to right):
 * `.filter().debounce()` means filter first, then debounce the filtered events.
 *
 * @param subscribe - Function that registers a callback and returns an unsubscribe function.
 * @param callback - Optional initial callback to invoke on each event.
 */
export function createEventStream(
  subscribe: (cb: (event: StateChangedEvent) => void) => () => void,
  callback?: (event: StateChangedEvent) => void,
): EventStream<any> {
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  const processors: Processor[] = [];
  const finalHandler = callback ?? (() => {});
  let disposed = false;

  // Run the processor chain for an incoming event
  const dispatch = (event: StateChangedEvent) => {
    if (disposed) return;
    let idx = 0;
    const next = (e: StateChangedEvent) => {
      if (idx < processors.length) {
        processors[idx++](e, next);
      } else {
        finalHandler(e);
      }
    };
    next(event);
  };

  // Subscribe immediately
  const baseUnsub = subscribe(dispatch);

  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    for (const t of timers) clearTimeout(t);
    timers.length = 0;
    baseUnsub();
  };

  const trackTimer = (t: ReturnType<typeof setTimeout>) => { timers.push(t); };
  const untrackTimer = (t: ReturnType<typeof setTimeout>) => {
    const idx = timers.indexOf(t);
    if (idx !== -1) timers.splice(idx, 1);
  };

  const stream: EventStream<any> = {
    unsubscribe: cleanup,

    filter(predicate) {
      processors.push((event, next) => {
        if (predicate(event)) next(event);
      });
      return stream;
    },

    map(transform) {
      processors.push((event, next) => {
        next(transform(event));
      });
      return stream;
    },

    debounce(ms) {
      let pending: ReturnType<typeof setTimeout> | null = null;
      processors.push((event, next) => {
        if (pending !== null) {
          clearTimeout(pending);
          untrackTimer(pending);
        }
        pending = setTimeout(() => {
          pending = null;
          next(event);
        }, ms);
        trackTimer(pending);
      });
      return stream;
    },

    throttle(ms) {
      let lastFired = 0;
      processors.push((event, next) => {
        const now = Date.now();
        if (now - lastFired >= ms) {
          lastFired = now;
          next(event);
        }
      });
      return stream;
    },

    distinctUntilChanged() {
      let lastState: string | undefined;
      processors.push((event, next) => {
        if (event.new_state !== lastState) {
          lastState = event.new_state;
          next(event);
        }
      });
      return stream;
    },

    transition(from, to) {
      processors.push((event, next) => {
        const fromMatch = from === '*' || event.old_state === from;
        const toMatch = to === '*' || event.new_state === to;
        if (fromMatch && toMatch) next(event);
      });
      return stream;
    },
  };

  return stream;
}

import type { StateChangedEvent, EventStream, Subscription } from './types.js';

/** A middleware that receives an event and calls next() to pass it downstream. */
type Processor = (event: StateChangedEvent, next: (event: StateChangedEvent) => void) => void;

/** Shared mutable ref so operators created before subscribe() can access the timer list. */
interface TimerRef {
  timers: Array<ReturnType<typeof setTimeout>>;
}

/**
 * Creates a lazy EventStream that defers subscription until `.subscribe()` is called.
 * Operators are applied in reading order (left to right):
 * `.filter().debounce().subscribe(cb)` means filter first, then debounce, then invoke cb.
 *
 * @param subscribeFn - Factory that registers a callback and returns an unsubscribe function.
 */
export function createEventStream(
  subscribeFn: (cb: (event: StateChangedEvent) => void) => () => void,
): EventStream<any> {
  const processors: Processor[] = [];
  // Shared ref — populated when subscribe() is called
  const ref: TimerRef = { timers: [] };

  const stream: EventStream<any> = {
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
          const idx = ref.timers.indexOf(pending);
          if (idx !== -1) ref.timers.splice(idx, 1);
        }
        pending = setTimeout(() => {
          pending = null;
          next(event);
        }, ms);
        ref.timers.push(pending);
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

    onTransition(from, to) {
      processors.push((event, next) => {
        const fromMatch = from === '*' || event.old_state === from;
        const toMatch = to === '*' || event.new_state === to;
        if (fromMatch && toMatch) next(event);
      });
      return stream;
    },

    subscribe(callback) {
      let disposed = false;

      const dispatch = (event: StateChangedEvent) => {
        if (disposed) return;
        let idx = 0;
        const next = (e: StateChangedEvent) => {
          if (idx < processors.length) {
            processors[idx++](e, next);
          } else {
            callback(e);
          }
        };
        next(event);
      };

      // Activate — register the HA event listener
      const baseUnsub = subscribeFn(dispatch);

      const subscription: Subscription = {
        unsubscribe() {
          if (disposed) return;
          disposed = true;
          for (const t of ref.timers) clearTimeout(t);
          ref.timers.length = 0;
          baseUnsub();
        },
      };

      return subscription;
    },
  };

  return stream;
}

import type { EntityContext, StatefulEntityDefinition } from '../types.js';

/** Built-in reducers for buffered values. */
export const average = (values: number[]) =>
  values.reduce((a, b) => a + b, 0) / values.length;
export const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
export const min = (values: number[]) => Math.min(...values);
export const max = (values: number[]) => Math.max(...values);
export const last = <T>(values: T[]) => values[values.length - 1];
export const count = (values: unknown[]) => values.length;

/**
 * Collects values into a buffer and publishes `reduce(buffer)` at each interval tick.
 */
export function buffered(
  entity: StatefulEntityDefinition,
  opts: { interval: number; reduce: (values: any[]) => any },
): StatefulEntityDefinition {
  const originalInit = entity.init as
    | ((this: EntityContext) => unknown)
    | undefined;
  return {
    ...entity,
    init(this: EntityContext) {
      const originalUpdate = this.update;
      let buffer: unknown[] = [];

      this.update = (value: unknown) => {
        buffer.push(value);
      };

      this.setInterval(() => {
        if (buffer.length > 0) {
          const result = opts.reduce(buffer);
          buffer = [];
          originalUpdate.call(this, result);
        }
      }, opts.interval);

      return originalInit?.call(this);
    },
  } as StatefulEntityDefinition;
}

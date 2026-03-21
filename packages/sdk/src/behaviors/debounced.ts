import type { EntityContext, StatefulEntityDefinition } from '../types.js';

/**
 * Delays publishing until updates stop arriving for `wait` ms.
 * The first update passes through immediately (no initial dead time).
 * Composes: `debounced(filtered(sensor({...}), pred), { wait: 500 })`
 */
export function debounced<T extends StatefulEntityDefinition>(
  entity: T,
  opts: { wait: number },
): T {
  const originalInit = entity.init as
    | ((this: EntityContext) => unknown)
    | undefined;
  return {
    ...entity,
    init(this: EntityContext) {
      const originalUpdate = this.update;
      let timer: unknown;
      let first = true;
      this.update = (value: unknown, attributes?: Record<string, unknown>) => {
        if (first) {
          first = false;
          originalUpdate.call(this, value, attributes);
          return;
        }
        if (timer) this.clearTimeout(timer);
        timer = this.setTimeout(
          () => originalUpdate.call(this, value, attributes),
          opts.wait,
        );
      };
      return originalInit?.call(this);
    },
  } as T;
}

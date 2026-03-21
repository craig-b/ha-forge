import type { EntityContext, StatefulEntityDefinition } from '../types.js';

/**
 * Delays publishing until updates stop arriving for `wait` ms.
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
      this.update = (value: unknown, attributes?: Record<string, unknown>) => {
        if (timer) clearTimeout(timer as any);
        timer = this.setTimeout(
          () => originalUpdate.call(this, value, attributes),
          opts.wait,
        );
      };
      return originalInit?.call(this);
    },
  } as T;
}

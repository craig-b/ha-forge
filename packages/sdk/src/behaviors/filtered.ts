import type { EntityContext, StatefulEntityDefinition } from '../types.js';

/**
 * Skips updates that fail the predicate.
 * Composes: `filtered(sensor({...}), (v) => v > 0)`
 */
export function filtered<T extends StatefulEntityDefinition>(
  entity: T,
  predicate: (value: any, attributes?: any) => boolean,
): T {
  const originalInit = entity.init as
    | ((this: EntityContext) => unknown)
    | undefined;
  return {
    ...entity,
    init(this: EntityContext) {
      const originalUpdate = this.update;
      this.update = (value: unknown, attributes?: Record<string, unknown>) => {
        if (predicate(value, attributes)) {
          originalUpdate.call(this, value, attributes);
        }
      };
      return originalInit?.call(this);
    },
  } as T;
}

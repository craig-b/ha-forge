import type { EntityContext, StatefulEntityDefinition } from '../types.js';

/**
 * Skips updates that fail the predicate.
 * Composes: `filtered(sensor({...}), (v) => v > 0)`
 */
export function filtered(
  entity: StatefulEntityDefinition,
  predicate: (value: any, attributes?: any) => boolean,
): StatefulEntityDefinition {
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
  } as StatefulEntityDefinition;
}

import type { EntityContext, StatefulEntityDefinition } from '../types.js';

/**
 * Captures the latest value on each update but only publishes at a fixed interval.
 * The first update publishes immediately (no initial delay).
 */
export function sampled(
  entity: StatefulEntityDefinition,
  opts: { interval: number },
): StatefulEntityDefinition {
  const originalInit = entity.init as
    | ((this: EntityContext) => unknown)
    | undefined;
  return {
    ...entity,
    init(this: EntityContext) {
      const originalUpdate = this.update;
      let latest: { value: unknown; attributes?: Record<string, unknown> } | undefined;
      let started = false;

      this.update = (value: unknown, attributes?: Record<string, unknown>) => {
        latest = { value, attributes };
        if (!started) {
          started = true;
          originalUpdate.call(this, value, attributes);
          this.setInterval(() => {
            if (latest) {
              originalUpdate.call(this, latest.value, latest.attributes);
            }
          }, opts.interval);
        }
      };
      return originalInit?.call(this);
    },
  } as StatefulEntityDefinition;
}

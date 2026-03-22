import type { NumberConfig, NumberDefinition, EntityContext, ComputedAttribute } from '../types.js';

/** Options for defining a number entity. */
export interface NumberOptions<TAttrs extends Record<string, unknown> = Record<string, unknown>> {
  /** Unique entity identifier. Becomes the object_id in MQTT topics (e.g. `'target_temp'` → `number.target_temp`). */
  id: string;
  /** Human-readable name shown in the HA UI. */
  name: string;
  /** Optional device to group this entity under. */
  device?: NumberDefinition['device'];
  /** Entity category — `'config'` or `'diagnostic'` entities are hidden from the default UI. */
  category?: NumberDefinition['category'];
  /** MDI icon override (e.g. `'mdi:numeric'`). */
  icon?: string;
  /** Number-specific MQTT discovery config (min, max, step, device_class). */
  config?: NumberConfig;
  /** Declarative attributes published alongside the entity state. Values can be static or reactive via `computed()`. */
  attributes?: { [K in keyof TAttrs]: TAttrs[K] | ComputedAttribute };
  /**
   * When `true` (default), the runtime auto-publishes the command as state after `onCommand` returns
   * (unless it returns `false` to reject). Set to `false` to require manual `this.update()` calls.
   */
  optimistic?: boolean;
  /**
   * Called when HA sends a new value to this number entity.
   * Optional when `optimistic` is `true` (default) — the number simply echoes commands as state.
   * @param command - The new numeric value.
   * @returns `false` to reject the command (no state change). Any other return (including `void`) confirms the command.
   */
  onCommand?(this: EntityContext<number, TAttrs>, command: number): void | boolean | Promise<void | boolean>;
  /**
   * Called once when the entity is deployed. Return the initial value.
   */
  init?(this: EntityContext<number, TAttrs>): number | Promise<number>;
  /** Called when the entity is torn down. Use for cleanup of external resources. */
  destroy?(this: EntityContext<number, TAttrs>): void | Promise<void>;
}

/**
 * Define a numeric input entity with min/max bounds.
 *
 * @param options - Number configuration including id, name, onCommand handler, and optional init/destroy.
 * @returns A `NumberDefinition` registered with Home Assistant via MQTT discovery.
 *
 * @example
 * ```ts
 * // Optimistic by default — echoes commands as state
 * number({
 *   id: 'fan_speed',
 *   name: 'Fan Speed',
 *   config: { min: 0, max: 100, step: 10, unit_of_measurement: '%' },
 *   init() { return 50; },
 * });
 *
 * // With validation — reject out-of-range values
 * number({
 *   id: 'fan_speed',
 *   name: 'Fan Speed',
 *   config: { min: 0, max: 100, step: 10 },
 *   onCommand(value) {
 *     if (value > 80 && !overrideEnabled) return false;
 *   },
 * });
 * ```
 */
export function number<TAttrs extends Record<string, unknown> = Record<string, unknown>>(options: NumberOptions<TAttrs>): NumberDefinition {
  return {
    ...options,
    type: 'number',
  };
}

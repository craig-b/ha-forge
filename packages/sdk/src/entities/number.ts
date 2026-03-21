import type { NumberConfig, NumberDefinition, EntityContext } from '../types.js';

/** Options for defining a number entity. */
export interface NumberOptions {
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
  /**
   * Called when HA sends a new value to this number entity.
   * @param command - The new numeric value.
   */
  onCommand(this: EntityContext<number>, command: number): void | Promise<void>;
  /**
   * Called once when the entity is deployed. Return the initial value.
   */
  init?(this: EntityContext<number>): number | Promise<number>;
  /** Called when the entity is torn down. Use for cleanup of external resources. */
  destroy?(this: EntityContext<number>): void | Promise<void>;
}

/**
 * Define a numeric input entity with min/max bounds.
 *
 * @param options - Number configuration including id, name, onCommand handler, and optional init/destroy.
 * @returns A `NumberDefinition` registered with Home Assistant via MQTT discovery.
 *
 * @example
 * ```ts
 * number({
 *   id: 'fan_speed',
 *   name: 'Fan Speed',
 *   config: { min: 0, max: 100, step: 10, unit_of_measurement: '%' },
 *   onCommand(value) {
 *     // Set hardware fan speed
 *     this.update(value);
 *   },
 *   init() {
 *     return 50;
 *   },
 * });
 * ```
 */
export function number(options: NumberOptions): NumberDefinition {
  return {
    ...options,
    type: 'number',
  };
}

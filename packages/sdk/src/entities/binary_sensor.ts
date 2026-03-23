import type { BinarySensorConfig, BinarySensorDefinition, EntityContext, ComputedAttribute } from '../types.js';

/** Options for defining a binary sensor entity. */
export interface BinarySensorOptions<TAttrs extends Record<string, unknown> = Record<string, unknown>> {
  /** Unique entity identifier. Becomes the object_id in MQTT topics (e.g. `'front_door'` → `binary_sensor.front_door`). */
  id: string;
  /** Human-readable name shown in the HA UI. */
  name: string;
  /** Optional device to group this entity under. */
  device?: BinarySensorDefinition['device'];
  /** Entity category — `'config'` or `'diagnostic'` entities are hidden from the default UI. */
  category?: BinarySensorDefinition['category'];
  /** MDI icon override (e.g. `'mdi:door'`). */
  icon?: string;
  /** Binary sensor-specific MQTT discovery config (device_class). */
  config?: BinarySensorConfig;
  /** Declarative attributes published alongside the entity state. Values can be static or reactive via `computed()`. */
  attributes?: { [K in keyof TAttrs]: TAttrs[K] | ComputedAttribute };
  /**
   * Called once when the entity is deployed. Return `'on'` or `'off'` as the initial state.
   * Use `this.poll()`, `this.events.stream()`, etc. to set up ongoing state updates.
   */
  init?(this: EntityContext<'on' | 'off', TAttrs>): 'on' | 'off' | Promise<'on' | 'off'>;
  /** Called when the entity is torn down. Use for cleanup of external resources. */
  destroy?(this: EntityContext<'on' | 'off', TAttrs>): void | Promise<void>;
}

/**
 * Define a read-only binary (on/off) sensor entity.
 *
 * @param options - Binary sensor configuration including id, name, and optional init/destroy callbacks.
 * @returns A `BinarySensorDefinition` registered with Home Assistant via MQTT discovery.
 *
 * @example
 * ```ts
 * binarySensor({
 *   id: 'front_door',
 *   name: 'Front Door',
 *   config: { device_class: 'door' },
 *   init() {
 *     this.events.stream('binary_sensor.zigbee_door')
 *       .subscribe((event) => {
 *         this.update(event.new_state === 'on' ? 'on' : 'off');
 *       });
 *     return 'off';
 *   },
 * });
 * ```
 */
export function binarySensor<TAttrs extends Record<string, unknown> = Record<string, unknown>>(options: BinarySensorOptions<TAttrs>): BinarySensorDefinition {
  return {
    ...options,
    type: 'binary_sensor',
  };
}

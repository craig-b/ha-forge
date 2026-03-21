import type { SensorConfig, SensorDefinition, EntityContext, ComputedAttribute } from '../types.js';

/** Options for defining a sensor entity. */
export interface SensorOptions<TAttrs extends Record<string, unknown> = Record<string, unknown>> {
  /** Unique entity identifier. Becomes the object_id in MQTT topics (e.g. `'cpu_temp'` → `sensor.cpu_temp`). */
  id: string;
  /** Human-readable name shown in the HA UI. */
  name: string;
  /** Optional device to group this entity under. */
  device?: SensorDefinition['device'];
  /** Entity category — `'config'` or `'diagnostic'` entities are hidden from the default UI. */
  category?: SensorDefinition['category'];
  /** MDI icon override (e.g. `'mdi:thermometer'`). */
  icon?: string;
  /** Sensor-specific MQTT discovery config (device_class, unit_of_measurement, state_class). */
  config?: SensorConfig;
  /** Declarative attributes published alongside the entity state. Values can be static or reactive via `computed()`. */
  attributes?: { [K in keyof TAttrs]: TAttrs[K] | ComputedAttribute };
  /**
   * Called once when the entity is deployed. Return the initial state value.
   * Use `this.poll()`, `this.ha.on()`, etc. to set up ongoing state updates.
   */
  init?(this: EntityContext<string | number, TAttrs>): string | number | Promise<string | number>;
  /** Called when the entity is torn down. Use for cleanup of external resources. */
  destroy?(this: EntityContext<string | number, TAttrs>): void | Promise<void>;
}

/**
 * Define a read-only sensor entity.
 *
 * @param options - Sensor configuration including id, name, and optional init/destroy callbacks.
 * @returns A `SensorDefinition` registered with Home Assistant via MQTT discovery.
 *
 * @example
 * ```ts
 * sensor({
 *   id: 'cpu_temp',
 *   name: 'CPU Temperature',
 *   config: {
 *     device_class: 'temperature',
 *     unit_of_measurement: '°C',
 *     state_class: 'measurement',
 *   },
 *   init() {
 *     this.poll(async () => {
 *       const resp = await this.fetch('http://localhost/api/temp');
 *       return (await resp.json()).celsius;
 *     }, { interval: 30_000 });
 *     return '0';
 *   },
 * });
 * ```
 */
export function sensor<TAttrs extends Record<string, unknown> = Record<string, unknown>>(options: SensorOptions<TAttrs>): SensorDefinition {
  return {
    ...options,
    type: 'sensor',
  };
}

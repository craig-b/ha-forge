import type { SensorConfig, SensorDefinition, SensorDeviceClass, SensorStateFor, EntityContext, ComputedAttribute } from '../types.js';

/** Options for defining a sensor entity. State type is inferred from the device class in config. */
export interface SensorOptions<
  DC extends SensorDeviceClass | undefined = undefined,
  TAttrs extends Record<string, unknown> = Record<string, unknown>,
> {
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
  config?: SensorConfig<DC>;
  /** Declarative attributes published alongside the entity state. Values can be static or reactive via `computed()`. */
  attributes?: { [K in keyof TAttrs]: TAttrs[K] | ComputedAttribute };
  /**
   * Called once when the entity is deployed. Return the initial state value.
   * Use `this.poll()`, `this.ha.on()`, etc. to set up ongoing state updates.
   */
  init?(this: EntityContext<SensorStateFor<DC>, TAttrs>): SensorStateFor<DC> | null | Promise<SensorStateFor<DC> | null>;
  /** Called when the entity is torn down. Use for cleanup of external resources. */
  destroy?(this: EntityContext<SensorStateFor<DC>, TAttrs>): void | Promise<void>;
}

/**
 * Define a read-only sensor entity.
 *
 * @param options - Sensor configuration including id, name, and optional init/destroy callbacks.
 * @returns A `SensorDefinition` registered with Home Assistant via MQTT discovery.
 *
 * @example
 * ```ts
 * // Numeric sensor — device_class: 'temperature' constrains state to number
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
 *     return 0;
 *   },
 * });
 *
 * // Timestamp sensor — device_class: 'timestamp' constrains state to Date
 * sensor({
 *   id: 'next_departure',
 *   name: 'Next Train',
 *   config: { device_class: 'timestamp' },
 *   init() { return new Date(); },
 * });
 * ```
 */
export function sensor<
  DC extends SensorDeviceClass | undefined = undefined,
  TAttrs extends Record<string, unknown> = Record<string, unknown>,
>(options: SensorOptions<DC, TAttrs>): SensorDefinition<DC> {
  return {
    ...options,
    type: 'sensor',
  } as SensorDefinition<DC>;
}

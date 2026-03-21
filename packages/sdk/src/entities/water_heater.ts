import type { WaterHeaterConfig, WaterHeaterDefinition, WaterHeaterCommand, WaterHeaterState, EntityContext, ComputedAttribute } from '../types.js';

/** Options for defining a water heater entity. */
export interface WaterHeaterOptions<TAttrs extends Record<string, unknown> = Record<string, unknown>> {
  /** Unique entity identifier. Becomes the object_id in MQTT topics (e.g. `'boiler'` → `water_heater.boiler`). */
  id: string;
  /** Human-readable name shown in the HA UI. */
  name: string;
  /** Optional device to group this entity under. */
  device?: WaterHeaterDefinition['device'];
  /** Entity category — `'config'` or `'diagnostic'` entities are hidden from the default UI. */
  category?: WaterHeaterDefinition['category'];
  /** MDI icon override (e.g. `'mdi:water-boiler'`). */
  icon?: string;
  /** Water heater-specific MQTT discovery config (modes, temp range, precision). Required. */
  config: WaterHeaterConfig;
  /** Declarative attributes published alongside the entity state. Values can be static or reactive via `computed()`. */
  attributes?: { [K in keyof TAttrs]: TAttrs[K] | ComputedAttribute };
  /**
   * Called when HA sends a command to this water heater (change mode, temperature).
   * @param command - Only changed fields are present.
   */
  onCommand(this: EntityContext<WaterHeaterState, TAttrs>, command: WaterHeaterCommand): void | Promise<void>;
  /**
   * Called once when the entity is deployed. Return the initial water heater state.
   */
  init?(this: EntityContext<WaterHeaterState, TAttrs>): WaterHeaterState | Promise<WaterHeaterState>;
  /** Called when the entity is torn down. Use for cleanup of external resources. */
  destroy?(this: EntityContext<WaterHeaterState, TAttrs>): void | Promise<void>;
}

/**
 * Define a water heater entity with temperature and mode control.
 *
 * @param options - Water heater configuration including id, name, config, onCommand handler, and optional init/destroy.
 * @returns A `WaterHeaterDefinition` registered with Home Assistant via MQTT discovery.
 *
 * @example
 * ```ts
 * waterHeater({
 *   id: 'boiler',
 *   name: 'Hot Water Boiler',
 *   config: {
 *     modes: ['off', 'eco', 'performance'],
 *     min_temp: 30,
 *     max_temp: 70,
 *   },
 *   onCommand(command) {
 *     this.update({
 *       mode: command.mode ?? 'eco',
 *       temperature: command.temperature,
 *     });
 *   },
 *   init() {
 *     return { mode: 'off' };
 *   },
 * });
 * ```
 */
export function waterHeater<TAttrs extends Record<string, unknown> = Record<string, unknown>>(options: WaterHeaterOptions<TAttrs>): WaterHeaterDefinition {
  return {
    ...options,
    type: 'water_heater',
  };
}

import type { ClimateConfig, ClimateDefinition, ClimateCommand, ClimateState, EntityContext } from '../types.js';

/** Options for defining a climate entity. */
export interface ClimateOptions {
  /** Unique entity identifier. Becomes the object_id in MQTT topics (e.g. `'bedroom'` → `climate.bedroom`). */
  id: string;
  /** Human-readable name shown in the HA UI. */
  name: string;
  /** Optional device to group this entity under. */
  device?: ClimateDefinition['device'];
  /** Entity category — `'config'` or `'diagnostic'` entities are hidden from the default UI. */
  category?: ClimateDefinition['category'];
  /** MDI icon override (e.g. `'mdi:thermostat'`). */
  icon?: string;
  /** Climate-specific MQTT discovery config (HVAC modes, temp range, fan/preset/swing modes). Required. */
  config: ClimateConfig;
  /**
   * Called when HA sends a command to this climate device (change mode, temperature, etc.).
   * @param command - Only changed fields are present.
   */
  onCommand(this: EntityContext<ClimateState>, command: ClimateCommand): void | Promise<void>;
  /**
   * Called once when the entity is deployed. Return the initial climate state.
   */
  init?(this: EntityContext<ClimateState>): ClimateState | Promise<ClimateState>;
  /** Called when the entity is torn down. Use for cleanup of external resources. */
  destroy?(this: EntityContext<ClimateState>): void | Promise<void>;
}

/**
 * Define a climate entity (thermostat, AC unit, heater, etc.).
 *
 * @param options - Climate configuration including id, name, config, onCommand handler, and optional init/destroy.
 * @returns A `ClimateDefinition` registered with Home Assistant via MQTT discovery.
 *
 * @example
 * ```ts
 * climate({
 *   id: 'bedroom_ac',
 *   name: 'Bedroom AC',
 *   config: {
 *     hvac_modes: ['off', 'cool', 'heat', 'auto'],
 *     min_temp: 16,
 *     max_temp: 30,
 *     temp_step: 0.5,
 *   },
 *   onCommand(command) {
 *     // Send command to physical device
 *     this.update({
 *       mode: command.hvac_mode ?? 'auto',
 *       temperature: command.temperature,
 *     });
 *   },
 *   init() {
 *     return { mode: 'off' };
 *   },
 * });
 * ```
 */
export function climate(options: ClimateOptions): ClimateDefinition {
  return {
    ...options,
    type: 'climate',
  };
}

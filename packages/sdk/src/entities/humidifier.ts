import type { HumidifierConfig, HumidifierDefinition, HumidifierCommand, HumidifierState, EntityContext } from '../types.js';

/** Options for defining a humidifier entity. */
export interface HumidifierOptions {
  /** Unique entity identifier. Becomes the object_id in MQTT topics (e.g. `'bedroom'` → `humidifier.bedroom`). */
  id: string;
  /** Human-readable name shown in the HA UI. */
  name: string;
  /** Optional device to group this entity under. */
  device?: HumidifierDefinition['device'];
  /** Entity category — `'config'` or `'diagnostic'` entities are hidden from the default UI. */
  category?: HumidifierDefinition['category'];
  /** MDI icon override (e.g. `'mdi:air-humidifier'`). */
  icon?: string;
  /** Humidifier-specific MQTT discovery config (device_class, humidity range, modes). */
  config?: HumidifierConfig;
  /**
   * Called when HA sends a command to this humidifier.
   * @param command - The humidifier command with desired state and parameters.
   */
  onCommand(this: EntityContext<HumidifierState>, command: HumidifierCommand): void | Promise<void>;
  /**
   * Called once when the entity is deployed. Return the initial humidifier state.
   */
  init?(this: EntityContext<HumidifierState>): HumidifierState | Promise<HumidifierState>;
  /** Called when the entity is torn down. Use for cleanup of external resources. */
  destroy?(this: EntityContext<HumidifierState>): void | Promise<void>;
}

/**
 * Define a humidifier/dehumidifier entity.
 *
 * @param options - Humidifier configuration including id, name, onCommand handler, and optional init/destroy.
 * @returns A `HumidifierDefinition` registered with Home Assistant via MQTT discovery.
 *
 * @example
 * ```ts
 * humidifier({
 *   id: 'bedroom_humidifier',
 *   name: 'Bedroom Humidifier',
 *   config: { device_class: 'humidifier', min_humidity: 30, max_humidity: 70 },
 *   onCommand(command) {
 *     this.update({
 *       state: command.state === 'ON' ? 'on' : (command.state === 'OFF' ? 'off' : 'on'),
 *       humidity: command.humidity,
 *     });
 *   },
 *   init() {
 *     return { state: 'off' };
 *   },
 * });
 * ```
 */
export function humidifier(options: HumidifierOptions): HumidifierDefinition {
  return {
    ...options,
    type: 'humidifier',
  };
}

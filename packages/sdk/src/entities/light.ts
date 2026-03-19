import type { LightConfig, LightDefinition, LightCommand, LightState, EntityContext } from '../types.js';

/** Options for defining a light entity. */
export interface LightOptions {
  /** Unique entity identifier. Becomes the object_id in MQTT topics (e.g. `'kitchen'` → `light.kitchen`). */
  id: string;
  /** Human-readable name shown in the HA UI. */
  name: string;
  /** Optional device to group this entity under. */
  device?: LightDefinition['device'];
  /** Entity category — `'config'` or `'diagnostic'` entities are hidden from the default UI. */
  category?: LightDefinition['category'];
  /** MDI icon override (e.g. `'mdi:ceiling-light'`). */
  icon?: string;
  /** Light-specific MQTT discovery config (color modes, effects, color temp range). Required. */
  config: LightConfig;
  /**
   * Called when HA sends a command to this light (turn on/off, change brightness/color).
   * @param command - The light command with desired state and parameters.
   */
  onCommand(this: EntityContext<LightState>, command: LightCommand): void | Promise<void>;
  /**
   * Called once when the entity is deployed. Return the initial light state.
   */
  init?(this: EntityContext<LightState>): LightState | Promise<LightState>;
  /** Called when the entity is torn down. Use for cleanup of external resources. */
  destroy?(this: EntityContext<LightState>): void | Promise<void>;
}

/**
 * Define a controllable light entity with optional brightness, color, and effects.
 *
 * @param options - Light configuration including id, name, config, onCommand handler, and optional init/destroy.
 * @returns A `LightDefinition` registered with Home Assistant via MQTT discovery.
 *
 * @example
 * ```ts
 * light({
 *   id: 'desk_lamp',
 *   name: 'Desk Lamp',
 *   config: {
 *     supported_color_modes: ['brightness', 'color_temp'],
 *     min_color_temp_kelvin: 2700,
 *     max_color_temp_kelvin: 6500,
 *   },
 *   onCommand(command) {
 *     // Send command to physical device
 *     this.update({
 *       state: command.state === 'ON' ? 'on' : 'off',
 *       brightness: command.brightness,
 *     });
 *   },
 *   init() {
 *     return { state: 'off' };
 *   },
 * });
 * ```
 */
export function light(options: LightOptions): LightDefinition {
  return {
    ...options,
    type: 'light',
  };
}

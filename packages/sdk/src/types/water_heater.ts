import type { BaseEntity, EntityContext } from './core.js';

/**
 * Operating modes for water heater entities.
 */
export type WaterHeaterMode = 'off' | 'eco' | 'electric' | 'gas' | 'heat_pump' | 'high_demand' | 'performance';

/** MQTT discovery configuration for water heater entities. */
export interface WaterHeaterConfig {
  /** Supported operating modes. */
  modes: WaterHeaterMode[];
  /** Minimum settable temperature. */
  min_temp?: number;
  /** Maximum settable temperature. */
  max_temp?: number;
  /** Temperature precision (e.g. `0.1` or `1.0`). */
  precision?: number;
  /** Temperature unit — `'C'` for Celsius, `'F'` for Fahrenheit. */
  temperature_unit?: 'C' | 'F';
}

/**
 * Command received from HA when a user interacts with a water heater entity.
 * All fields are optional — only changed values are sent.
 */
export interface WaterHeaterCommand {
  /** Target operating mode. */
  mode?: WaterHeaterMode;
  /** Target temperature. */
  temperature?: number;
}

/** Current state of a water heater entity published to HA. */
export interface WaterHeaterState {
  /** Current operating mode. */
  mode: WaterHeaterMode;
  /** Target temperature. */
  temperature?: number;
  /** Current measured temperature. */
  current_temperature?: number;
}

/** Entity definition for a water heater entity. */
export interface WaterHeaterDefinition extends BaseEntity<WaterHeaterState, WaterHeaterConfig> {
  type: 'water_heater';
  /**
   * Called when HA sends a command to this water heater.
   * @param command - The water heater command with changed settings.
   */
  onCommand(this: EntityContext<WaterHeaterState>, command: WaterHeaterCommand): void | Promise<void>;
}

import type { BaseEntity, EntityContext } from './core.js';

/**
 * HVAC operating modes for climate entities.
 *
 * - `'off'` — System is off.
 * - `'heat'` — Heating only.
 * - `'cool'` — Cooling only.
 * - `'heat_cool'` — Dual-setpoint heating and cooling (auto-switch).
 * - `'auto'` — Device determines heating/cooling automatically.
 * - `'dry'` — Dehumidification mode.
 * - `'fan_only'` — Fan circulation only, no heating or cooling.
 */
export type HVACMode = 'off' | 'heat' | 'cool' | 'heat_cool' | 'auto' | 'dry' | 'fan_only';

/** MQTT discovery configuration for climate entities. */
export interface ClimateConfig {
  /** Supported HVAC modes for this climate device. */
  hvac_modes: HVACMode[];
  /** Supported fan speed modes (e.g. `['low', 'medium', 'high']`). */
  fan_modes?: string[];
  /** Supported preset modes (e.g. `['home', 'away', 'boost']`). */
  preset_modes?: string[];
  /** Supported swing modes (e.g. `['on', 'off']`). */
  swing_modes?: string[];
  /** Minimum settable temperature. */
  min_temp?: number;
  /** Maximum settable temperature. */
  max_temp?: number;
  /** Temperature increment step. */
  temp_step?: number;
  /** Temperature unit — `'C'` for Celsius, `'F'` for Fahrenheit. */
  temperature_unit?: 'C' | 'F';
}

/**
 * Command received from HA when a user interacts with a climate entity.
 * All fields are optional — only changed values are sent.
 */
export interface ClimateCommand {
  /** Target HVAC mode. */
  hvac_mode?: HVACMode;
  /** Target temperature. */
  temperature?: number;
  /** Upper bound for dual-setpoint mode. */
  target_temp_high?: number;
  /** Lower bound for dual-setpoint mode. */
  target_temp_low?: number;
  /** Target fan mode. */
  fan_mode?: string;
  /** Target swing mode. */
  swing_mode?: string;
  /** Target preset mode. */
  preset_mode?: string;
}

/** Current state of a climate entity published to HA. */
export interface ClimateState {
  /** Current HVAC operating mode. */
  mode: HVACMode;
  /** Current measured temperature from the device's sensor. */
  current_temperature?: number;
  /** Target temperature setpoint. */
  temperature?: number;
  /** Upper target temperature for dual-setpoint mode. */
  target_temp_high?: number;
  /** Lower target temperature for dual-setpoint mode. */
  target_temp_low?: number;
  /** Current fan mode. */
  fan_mode?: string;
  /** Current swing mode. */
  swing_mode?: string;
  /** Current preset mode. */
  preset_mode?: string;
  /** Current HVAC action — what the device is actually doing right now. */
  action?: 'off' | 'heating' | 'cooling' | 'drying' | 'idle' | 'fan';
}

/** Entity definition for a climate device (thermostat, AC, etc.). */
export interface ClimateDefinition extends BaseEntity<ClimateState, ClimateConfig> {
  type: 'climate';
  /**
   * Called when HA sends a command to this climate device.
   * @param command - The climate command with changed settings.
   */
  onCommand(this: EntityContext<ClimateState>, command: ClimateCommand): void | Promise<void>;
}

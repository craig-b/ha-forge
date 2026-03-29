import type { BaseEntity, EntityContext } from './core.js';

/** MQTT discovery configuration for fan entities. */
export interface FanConfig {
  /** List of preset fan modes (e.g. `['auto', 'smart', 'sleep']`). */
  preset_modes?: string[];
  /** Minimum speed percentage (default: 1). */
  speed_range_min?: number;
  /** Maximum speed percentage (default: 100). */
  speed_range_max?: number;
}

/**
 * Command received from HA when a user interacts with a fan entity.
 * All fields are optional — only changed values are sent.
 */
export interface FanCommand {
  /** Desired power state. */
  state?: 'ON' | 'OFF';
  /** Speed percentage (0–100). */
  percentage?: number;
  /** Target preset mode. */
  preset_mode?: string;
  /** Oscillation state. */
  oscillation?: 'oscillate_on' | 'oscillate_off';
  /** Fan direction. */
  direction?: 'forward' | 'reverse';
}

/** Current state of a fan entity published to HA. */
export interface FanState {
  /** Power state. */
  state: 'on' | 'off';
  /** Current speed percentage (0–100). */
  percentage?: number;
  /** Current preset mode. */
  preset_mode?: string;
  /** Current oscillation state. */
  oscillation?: 'on' | 'off';
  /** Current direction. */
  direction?: 'forward' | 'reverse';
}

/** Entity definition for a controllable fan. */
export interface FanDefinition extends BaseEntity<FanState, FanConfig> {
  type: 'fan';
  /**
   * Called when HA sends a command to this fan.
   * @param command - The fan command with desired state and parameters.
   */
  onCommand(this: EntityContext<FanState>, command: FanCommand): void | Promise<void>;
}

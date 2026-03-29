import type { BaseEntity, EntityContext } from './core.js';

/**
 * Device class for humidifier entities.
 */
export type HumidifierDeviceClass = 'humidifier' | 'dehumidifier';

/** MQTT discovery configuration for humidifier entities. */
export interface HumidifierConfig {
  /** Device class — `'humidifier'` or `'dehumidifier'`. */
  device_class?: HumidifierDeviceClass;
  /** Minimum target humidity (default: 0). */
  min_humidity?: number;
  /** Maximum target humidity (default: 100). */
  max_humidity?: number;
  /** Supported operating modes. */
  modes?: string[];
}

/**
 * Command received from HA when a user interacts with a humidifier entity.
 * All fields are optional — only changed values are sent.
 */
export interface HumidifierCommand {
  /** Desired power state. */
  state?: 'ON' | 'OFF';
  /** Target humidity percentage. */
  humidity?: number;
  /** Target operating mode. */
  mode?: string;
}

/** Current state of a humidifier entity published to HA. */
export interface HumidifierState {
  /** Power state. */
  state: 'on' | 'off';
  /** Current target humidity. */
  humidity?: number;
  /** Current operating mode. */
  mode?: string;
  /** Current measured humidity. */
  current_humidity?: number;
  /** Current action — what the device is actually doing. */
  action?: 'off' | 'humidifying' | 'drying' | 'idle';
}

/** Entity definition for a humidifier/dehumidifier entity. */
export interface HumidifierDefinition extends BaseEntity<HumidifierState, HumidifierConfig> {
  type: 'humidifier';
  /**
   * Called when HA sends a command to this humidifier.
   * @param command - The humidifier command with desired state and parameters.
   */
  onCommand(this: EntityContext<HumidifierState>, command: HumidifierCommand): void | Promise<void>;
}

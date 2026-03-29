import type { BaseEntity, EntityContext } from './core.js';

/**
 * Device class for valve entities.
 */
export type ValveDeviceClass = 'gas' | 'water';

/** MQTT discovery configuration for valve entities. */
export interface ValveConfig {
  /** Valve device class — determines icon in HA. */
  device_class?: ValveDeviceClass;
  /** Whether this valve reports numeric position (0–100). */
  reports_position?: boolean;
}

/**
 * Command received from HA when a user interacts with a valve entity.
 * Discriminated union on the `action` field.
 */
export type ValveCommand =
  | { action: 'open' }
  | { action: 'close' }
  | { action: 'stop' }
  | { action: 'set_position'; position: number };

/**
 * Possible states for a valve entity.
 */
export type ValveState = 'open' | 'opening' | 'closed' | 'closing' | 'stopped';

/** Entity definition for a controllable valve. */
export interface ValveDefinition extends BaseEntity<ValveState, ValveConfig> {
  type: 'valve';
  /**
   * Called when HA sends a command to this valve.
   * @param command - The valve command (open, close, stop, set_position).
   */
  onCommand(this: EntityContext<ValveState>, command: ValveCommand): void | Promise<void>;
}

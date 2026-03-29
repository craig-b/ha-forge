import type { BaseEntity, EntityContext } from './core.js';

/** MQTT discovery configuration for vacuum entities. */
export interface VacuumConfig {
  /** List of supported fan speed levels. */
  fan_speed_list?: string[];
}

/** Commands that can be sent to a vacuum entity. */
export type VacuumCommand =
  | { action: 'start' }
  | { action: 'pause' }
  | { action: 'stop' }
  | { action: 'return_to_base' }
  | { action: 'clean_spot' }
  | { action: 'locate' }
  | { action: 'set_fan_speed'; fan_speed: string };

/**
 * Possible states for a vacuum entity.
 */
export type VacuumState = 'cleaning' | 'docked' | 'paused' | 'idle' | 'returning' | 'error';

/** Entity definition for a robot vacuum entity. */
export interface VacuumDefinition extends BaseEntity<VacuumState, VacuumConfig> {
  type: 'vacuum';
  /**
   * Called when HA sends a command to this vacuum.
   * @param command - The vacuum command.
   */
  onCommand(this: EntityContext<VacuumState>, command: VacuumCommand): void | Promise<void>;
}

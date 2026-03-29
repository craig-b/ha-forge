import type { BaseEntity, BinaryState, EntityContext } from './core.js';

/** MQTT discovery configuration for siren entities. */
export interface SirenConfig {
  /** List of available alarm tones. */
  available_tones?: string[];
  /** Whether the siren supports setting duration. */
  support_duration?: boolean;
  /** Whether the siren supports setting volume (0–1). */
  support_volume_set?: boolean;
}

/**
 * Command received from HA when a user interacts with a siren entity.
 */
export interface SirenCommand {
  /** Desired power state. */
  state: 'ON' | 'OFF';
  /** Selected tone name. */
  tone?: string;
  /** Duration in seconds. */
  duration?: number;
  /** Volume level (0.0–1.0). */
  volume_level?: number;
}

/** Entity definition for a siren/alarm entity. */
export interface SirenDefinition extends BaseEntity<BinaryState, SirenConfig> {
  type: 'siren';
  /**
   * Called when HA sends a command to this siren.
   * @param command - The siren command with desired state and parameters.
   */
  onCommand(this: EntityContext<BinaryState>, command: SirenCommand): void | Promise<void>;
}

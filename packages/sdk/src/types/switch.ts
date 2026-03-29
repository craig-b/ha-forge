import type { BaseEntity, BinaryState, EntityContext } from './core.js';

/** MQTT discovery configuration for switch entities. */
export interface SwitchConfig {
  /** Switch device class — `'outlet'` for power outlets, `'switch'` for generic switches. */
  device_class?: 'outlet' | 'switch';
}

/** Entity definition for a controllable on/off switch. */
export interface SwitchDefinition extends BaseEntity<BinaryState, SwitchConfig> {
  type: 'switch';
  /**
   * When `true` (default), the runtime auto-publishes the command as state after `onCommand` returns
   * (unless it returns `false` to reject). Set to `false` to require manual `this.update()` calls.
   */
  optimistic?: boolean;
  /**
   * Called when HA sends a command to this switch.
   * @param command - `'ON'` or `'OFF'`.
   * @returns `false` to reject the command (no state change). Any other return (including `void`) confirms the command.
   */
  onCommand?(this: EntityContext<BinaryState>, command: 'ON' | 'OFF'): void | boolean | Promise<void | boolean>;
}

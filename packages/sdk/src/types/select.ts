import type { BaseEntity, EntityContext } from './core.js';

/** MQTT discovery configuration for select entities. */
export interface SelectConfig {
  /** List of selectable options. Required. */
  options: string[];
}

/** Entity definition for a dropdown selection entity. */
export interface SelectDefinition extends BaseEntity<string, SelectConfig> {
  type: 'select';
  /**
   * When `true` (default), the runtime auto-publishes the command as state after `onCommand` returns
   * (unless it returns `false` to reject). Set to `false` to require manual `this.update()` calls.
   */
  optimistic?: boolean;
  /**
   * Called when HA sends a new selection to this select entity.
   * @param command - The selected option string.
   * @returns `false` to reject the command (no state change). Any other return (including `void`) confirms the command.
   */
  onCommand?(this: EntityContext<string>, command: string): void | boolean | Promise<void | boolean>;
}

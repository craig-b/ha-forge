import type { BaseEntity, EntityContext } from './core.js';

/** MQTT discovery configuration for text entities. */
export interface TextConfig {
  /** Minimum text length (default: 0). */
  min?: number;
  /** Maximum text length (default: 255). */
  max?: number;
  /** Regex pattern for input validation. */
  pattern?: string;
  /** Display mode — `'text'` or `'password'`. */
  mode?: 'text' | 'password';
}

/** Entity definition for a text input entity. */
export interface TextDefinition extends BaseEntity<string, TextConfig> {
  type: 'text';
  /**
   * When `true` (default), the runtime auto-publishes the command as state after `onCommand` returns
   * (unless it returns `false` to reject). Set to `false` to require manual `this.update()` calls.
   */
  optimistic?: boolean;
  /**
   * Called when HA sends new text to this text entity.
   * @param command - The new text value.
   * @returns `false` to reject the command (no state change). Any other return (including `void`) confirms the command.
   */
  onCommand?(this: EntityContext<string>, command: string): void | boolean | Promise<void | boolean>;
}

import type { BaseEntity, EntityContext } from './core.js';

/** Entity definition for a notification target entity (write-only). */
export interface NotifyDefinition extends BaseEntity<never> {
  type: 'notify';
  /**
   * Called when a notification is sent to this entity.
   * @param message - The notification message text.
   */
  onNotify(this: EntityContext<never>, message: string): void | Promise<void>;
}

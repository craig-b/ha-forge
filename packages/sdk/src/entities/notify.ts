import type { NotifyDefinition, EntityContext, ComputedAttribute } from '../types.js';

/** Options for defining a notify entity. */
export interface NotifyOptions<TAttrs extends Record<string, unknown> = Record<string, unknown>> {
  /** Unique entity identifier. Becomes the object_id in MQTT topics (e.g. `'kitchen_display'` → `notify.kitchen_display`). */
  id: string;
  /** Human-readable name shown in the HA UI. */
  name: string;
  /** Optional device to group this entity under. */
  device?: NotifyDefinition['device'];
  /** Entity category — `'config'` or `'diagnostic'` entities are hidden from the default UI. */
  category?: NotifyDefinition['category'];
  /** MDI icon override (e.g. `'mdi:message'`). */
  icon?: string;
  /** Declarative attributes published alongside the entity state. Values can be static or reactive via `computed()`. */
  attributes?: { [K in keyof TAttrs]: TAttrs[K] | ComputedAttribute };
  /**
   * Called when a notification is sent to this entity.
   * @param message - The notification message text.
   */
  onNotify(this: EntityContext<never, TAttrs>, message: string): void | Promise<void>;
}

/**
 * Define a notification target entity (write-only).
 *
 * @param options - Notify configuration including id, name, and onNotify handler.
 * @returns A `NotifyDefinition` registered with Home Assistant via MQTT discovery.
 *
 * @example
 * ```ts
 * notify({
 *   id: 'kitchen_display',
 *   name: 'Kitchen Display',
 *   onNotify(message) {
 *     this.log.info(`Notification: ${message}`);
 *     // Send to physical display
 *   },
 * });
 * ```
 */
export function notify<TAttrs extends Record<string, unknown> = Record<string, unknown>>(options: NotifyOptions<TAttrs>): NotifyDefinition {
  return {
    ...options,
    type: 'notify',
  };
}

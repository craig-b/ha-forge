import type { UpdateConfig, UpdateDefinition, UpdateState, EntityContext, ComputedAttribute } from '../types.js';

/** Options for defining an update entity. */
export interface UpdateOptions<TAttrs extends Record<string, unknown> = Record<string, unknown>> {
  /** Unique entity identifier. Becomes the object_id in MQTT topics (e.g. `'firmware'` → `update.firmware`). */
  id: string;
  /** Human-readable name shown in the HA UI. */
  name: string;
  /** Optional device to group this entity under. */
  device?: UpdateDefinition['device'];
  /** Entity category — `'config'` or `'diagnostic'` entities are hidden from the default UI. */
  category?: UpdateDefinition['category'];
  /** MDI icon override (e.g. `'mdi:update'`). */
  icon?: string;
  /** Update-specific MQTT discovery config (device_class). */
  config?: UpdateConfig;
  /** Declarative attributes published alongside the entity state. Values can be static or reactive via `computed()`. */
  attributes?: { [K in keyof TAttrs]: TAttrs[K] | ComputedAttribute };
  /**
   * Called once when the entity is deployed. Return the initial update state.
   */
  init?(this: EntityContext<UpdateState, TAttrs>): UpdateState | Promise<UpdateState>;
  /** Called when the entity is torn down. Use for cleanup of external resources. */
  destroy?(this: EntityContext<UpdateState, TAttrs>): void | Promise<void>;
  /**
   * Called when HA requests installation of the update.
   */
  onInstall?(this: EntityContext<UpdateState, TAttrs>): void | Promise<void>;
}

/**
 * Define an update availability indicator entity.
 *
 * @param options - Update configuration including id, name, and optional init/destroy/onInstall.
 * @returns An `UpdateDefinition` registered with Home Assistant via MQTT discovery.
 *
 * @example
 * ```ts
 * update({
 *   id: 'firmware',
 *   name: 'Firmware Update',
 *   config: { device_class: 'firmware' },
 *   init() {
 *     this.poll(async () => {
 *       const latest = await checkForUpdates();
 *       return {
 *         installed_version: '1.0.0',
 *         latest_version: latest.version,
 *         release_summary: latest.changelog,
 *       };
 *     }, { interval: 3600_000 });
 *     return { installed_version: '1.0.0', latest_version: null };
 *   },
 *   onInstall() {
 *     this.log.info('Installing update...');
 *   },
 * });
 * ```
 */
export function update<TAttrs extends Record<string, unknown> = Record<string, unknown>>(options: UpdateOptions<TAttrs>): UpdateDefinition {
  return {
    ...options,
    type: 'update',
  };
}

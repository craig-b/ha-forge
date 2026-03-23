import type { ImageConfig, ImageDefinition, EntityContext, ComputedAttribute } from '../types.js';

/** Options for defining an image entity. */
export interface ImageOptions<TAttrs extends Record<string, unknown> = Record<string, unknown>> {
  /** Unique entity identifier. Becomes the object_id in MQTT topics (e.g. `'snapshot'` → `image.snapshot`). */
  id: string;
  /** Human-readable name shown in the HA UI. */
  name: string;
  /** Optional device to group this entity under. */
  device?: ImageDefinition['device'];
  /** Entity category — `'config'` or `'diagnostic'` entities are hidden from the default UI. */
  category?: ImageDefinition['category'];
  /** MDI icon override (e.g. `'mdi:image'`). */
  icon?: string;
  /** Image-specific MQTT discovery config (content_type). */
  config?: ImageConfig;
  /** Declarative attributes published alongside the entity state. Values can be static or reactive via `computed()`. */
  attributes?: { [K in keyof TAttrs]: TAttrs[K] | ComputedAttribute };
  /**
   * Called once when the entity is deployed. Return the initial image URL.
   */
  init?(this: EntityContext<string, TAttrs>): string | Promise<string>;
  /** Called when the entity is torn down. Use for cleanup of external resources. */
  destroy?(this: EntityContext<string, TAttrs>): void | Promise<void>;
}

/**
 * Define a static image entity. State is the image URL.
 *
 * @param options - Image configuration including id, name, and optional init/destroy.
 * @returns An `ImageDefinition` registered with Home Assistant via MQTT discovery.
 *
 * @example
 * ```ts
 * image({
 *   id: 'doorbell_snapshot',
 *   name: 'Doorbell Snapshot',
 *   init() {
 *     this.events.stream('binary_sensor.doorbell')
 *       .subscribe(() => {
 *         this.update('http://camera.local/snapshot.jpg');
 *       });
 *     return 'http://camera.local/snapshot.jpg';
 *   },
 * });
 * ```
 */
export function image<TAttrs extends Record<string, unknown> = Record<string, unknown>>(options: ImageOptions<TAttrs>): ImageDefinition {
  return {
    ...options,
    type: 'image',
  };
}

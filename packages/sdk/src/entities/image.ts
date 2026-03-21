import type { ImageConfig, ImageDefinition, EntityContext } from '../types.js';

/** Options for defining an image entity. */
export interface ImageOptions {
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
  /**
   * Called once when the entity is deployed. Return the initial image URL.
   */
  init?(this: EntityContext<string>): string | Promise<string>;
  /** Called when the entity is torn down. Use for cleanup of external resources. */
  destroy?(this: EntityContext<string>): void | Promise<void>;
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
 *     this.events.on('binary_sensor.doorbell', () => {
 *       this.update('http://camera.local/snapshot.jpg');
 *     });
 *     return 'http://camera.local/snapshot.jpg';
 *   },
 * });
 * ```
 */
export function image(options: ImageOptions): ImageDefinition {
  return {
    ...options,
    type: 'image',
  };
}

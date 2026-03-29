import type { BaseEntity } from './core.js';

/** MQTT discovery configuration for image entities. */
export interface ImageConfig {
  /** Content type of the image (default: `'image/jpeg'`). */
  content_type?: string;
}

/** Entity definition for a static image entity. State is the image URL. */
export interface ImageDefinition extends BaseEntity<string, ImageConfig> {
  type: 'image';
}

import type { BaseEntity, EntityContext } from './core.js';

/**
 * Device class for update entities.
 *
 * @see https://developers.home-assistant.io/docs/core/entity/update/#available-device-classes
 */
export type UpdateDeviceClass = 'firmware';

/** MQTT discovery configuration for update entities. */
export interface UpdateConfig {
  /** Update device class. */
  device_class?: UpdateDeviceClass;
}

/** Current state of an update entity published to HA (JSON). */
export interface UpdateState {
  /** Currently installed version string. */
  installed_version: string | null;
  /** Latest available version string. */
  latest_version: string | null;
  /** Update title/name. */
  title?: string;
  /** Release summary/changelog. */
  release_summary?: string;
  /** URL to full release notes. */
  release_url?: string;
  /** URL to entity picture/icon. */
  entity_picture?: string;
}

/** Entity definition for an update availability indicator entity. */
export interface UpdateDefinition extends BaseEntity<UpdateState, UpdateConfig> {
  type: 'update';
  /**
   * Called when HA requests installation of the update.
   */
  onInstall?(this: EntityContext<UpdateState>): void | Promise<void>;
}

import type { BaseEntity, EntityContext } from './core.js';

/**
 * Device class for button entities.
 *
 * @see https://developers.home-assistant.io/docs/core/entity/button/#available-device-classes
 */
export type ButtonDeviceClass = 'identify' | 'restart' | 'update';

/** MQTT discovery configuration for button entities. */
export interface ButtonConfig {
  /** Button device class — determines icon in HA. */
  device_class?: ButtonDeviceClass;
}

/** Entity definition for a momentary button entity (command only, no state). */
export interface ButtonDefinition extends BaseEntity<never, ButtonConfig> {
  type: 'button';
  /**
   * Called when the button is pressed in HA.
   */
  onPress(this: EntityContext<never>): void | Promise<void>;
}

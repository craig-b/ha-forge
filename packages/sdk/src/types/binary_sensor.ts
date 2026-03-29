import type { BaseEntity, BinaryState } from './core.js';

/**
 * Device class for binary sensor entities. Determines the default icon
 * and on/off label text in the HA UI.
 *
 * @see https://developers.home-assistant.io/docs/core/entity/binary-sensor/#available-device-classes
 */
export type BinarySensorDeviceClass =
  | 'battery'
  | 'battery_charging'
  | 'carbon_monoxide'
  | 'cold'
  | 'connectivity'
  | 'door'
  | 'garage_door'
  | 'gas'
  | 'heat'
  | 'light'
  | 'lock'
  | 'moisture'
  | 'motion'
  | 'moving'
  | 'occupancy'
  | 'opening'
  | 'plug'
  | 'power'
  | 'presence'
  | 'problem'
  | 'running'
  | 'safety'
  | 'smoke'
  | 'sound'
  | 'tamper'
  | 'update'
  | 'vibration'
  | 'window';

/** MQTT discovery configuration for binary sensor entities. */
export interface BinarySensorConfig {
  /** Binary sensor device class — determines icon and on/off labels in HA. */
  device_class?: BinarySensorDeviceClass;
}

/** Entity definition for a binary (on/off) sensor. */
export interface BinarySensorDefinition extends BaseEntity<BinaryState, BinarySensorConfig> {
  type: 'binary_sensor';
}

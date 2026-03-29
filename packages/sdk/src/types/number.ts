import type { BaseEntity, EntityContext } from './core.js';

/**
 * Device class for number entities.
 *
 * @see https://developers.home-assistant.io/docs/core/entity/number/#available-device-classes
 */
export type NumberDeviceClass =
  | 'apparent_power'
  | 'aqi'
  | 'atmospheric_pressure'
  | 'battery'
  | 'carbon_dioxide'
  | 'carbon_monoxide'
  | 'current'
  | 'data_rate'
  | 'data_size'
  | 'distance'
  | 'duration'
  | 'energy'
  | 'energy_storage'
  | 'frequency'
  | 'gas'
  | 'humidity'
  | 'illuminance'
  | 'irradiance'
  | 'moisture'
  | 'monetary'
  | 'nitrogen_dioxide'
  | 'nitrogen_monoxide'
  | 'nitrous_oxide'
  | 'ozone'
  | 'ph'
  | 'pm1'
  | 'pm10'
  | 'pm25'
  | 'power'
  | 'power_factor'
  | 'precipitation'
  | 'precipitation_intensity'
  | 'pressure'
  | 'reactive_power'
  | 'signal_strength'
  | 'sound_pressure'
  | 'speed'
  | 'sulphur_dioxide'
  | 'temperature'
  | 'volatile_organic_compounds'
  | 'volatile_organic_compounds_parts'
  | 'voltage'
  | 'volume'
  | 'volume_flow_rate'
  | 'volume_storage'
  | 'water'
  | 'weight'
  | 'wind_speed';

/** MQTT discovery configuration for number entities. */
export interface NumberConfig {
  /** Number device class — determines icon and default unit in HA. */
  device_class?: NumberDeviceClass;
  /** Minimum value (default: 1). */
  min?: number;
  /** Maximum value (default: 100). */
  max?: number;
  /** Step size (default: 1, minimum: 0.001). */
  step?: number;
  /** Unit of measurement displayed alongside the value. */
  unit_of_measurement?: string;
  /** Display mode — `'auto'`, `'box'`, or `'slider'`. */
  mode?: 'auto' | 'box' | 'slider';
}

/** Entity definition for a numeric input entity. */
export interface NumberDefinition extends BaseEntity<number, NumberConfig> {
  type: 'number';
  /**
   * When `true` (default), the runtime auto-publishes the command as state after `onCommand` returns
   * (unless it returns `false` to reject). Set to `false` to require manual `this.update()` calls.
   */
  optimistic?: boolean;
  /**
   * Called when HA sends a new value to this number entity.
   * @param command - The new numeric value.
   * @returns `false` to reject the command (no state change). Any other return (including `void`) confirms the command.
   */
  onCommand?(this: EntityContext<number>, command: number): void | boolean | Promise<void | boolean>;
}

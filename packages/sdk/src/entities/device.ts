import type { DeviceMemberDefinition, DeviceOptions, DeviceDefinition } from '../types.js';

/**
 * Define a device that groups multiple entities with a shared lifecycle.
 *
 * The device's `init()` receives a context with `this.entities` for updating
 * each entity, plus managed timers, HTTP, HA client, and MQTT access.
 *
 * Members can be entity definitions (sensor, switch, etc.) or non-entity
 * definitions (task, mode, cron, automation) — each gets a typed handle.
 *
 * @example
 * ```ts
 * export default device({
 *   id: 'weather_station',
 *   name: 'Weather Station',
 *   entities: {
 *     temperature: sensor({
 *       id: 'ws_temperature',
 *       name: 'Temperature',
 *       config: { device_class: 'temperature', unit_of_measurement: '°C' },
 *     }),
 *     reboot: task({ id: 'reboot', name: 'Reboot', run() {} }),
 *   },
 *   init() {
 *     this.entities.temperature.update(22.5);
 *     this.entities.reboot.trigger();
 *   },
 * });
 * ```
 */
export function device<TEntities extends Record<string, DeviceMemberDefinition>>(
  options: DeviceOptions<TEntities>,
): DeviceDefinition<TEntities> {
  return {
    __kind: 'device',
    ...options,
  };
}

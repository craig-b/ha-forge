import type { EntityDefinition, EntityFactory } from '../types.js';

/**
 * Create an entity factory for dynamic entity generation.
 * Use this when entities need to be created at runtime based on configuration or external data.
 *
 * @param factory - A function that returns an array of entity definitions (or a Promise of one).
 * @returns An `EntityFactory` that the runtime will call during deployment.
 *
 * @example
 * ```ts
 * entityFactory(async () => {
 *   const rooms = await fetchRooms();
 *   return rooms.map(room =>
 *     sensor({
 *       id: `${room.id}_temp`,
 *       name: `${room.name} Temperature`,
 *       config: { device_class: 'temperature', unit_of_measurement: '°C' },
 *       init() {
 *         this.poll(() => fetchTemp(room.id), { interval: 60_000 });
 *         return '0';
 *       },
 *     })
 *   );
 * });
 * ```
 */
export function entityFactory(
  factory: () => EntityDefinition[] | Promise<EntityDefinition[]>,
): EntityFactory {
  return factory;
}

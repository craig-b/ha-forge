import type { EntityDefinition } from './types.js';

/** Internal type representing a resolved entity with its source file and device assignment. */
export interface ResolvedEntity {
  /** The entity definition. */
  definition: EntityDefinition;
  /** Path to the source `.ts` file that defined this entity. */
  sourceFile: string;
  /** Device ID this entity is assigned to. */
  deviceId: string;
}

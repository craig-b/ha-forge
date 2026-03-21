import type { DeviceInfo, EntityType } from '@ha-forge/sdk';

/**
 * Minimal entity definition for transport registration (MQTT discovery).
 * Matches the common fields from BaseEntity that the transport needs.
 * EntityDefinition satisfies this naturally (all definitions extend BaseEntity);
 * synthetic entities (from tasks, modes, crons) can use it directly without
 * unsafe casts.
 */
export interface TransportEntityDef {
  id: string;
  type: EntityType;
  name: string | null;
  icon?: string;
  category?: 'config' | 'diagnostic';
  device?: DeviceInfo;
  config?: unknown;
}

/** A resolved entity for transport registration. */
export interface RegistrableEntity {
  definition: TransportEntityDef;
  deviceId: string;
}

export interface Transport {
  supports(type: EntityType): boolean;
  register(entity: RegistrableEntity): Promise<void>;
  publishState(entityId: string, state: unknown, attributes?: Record<string, unknown>): Promise<void>;
  onCommand(entityId: string, handler: (command: unknown) => void): void;
  deregister(entityId: string): Promise<void>;
  /** Record a publish failure for an entity (marks unavailable after repeated failures). */
  recordEntityFailure?(entityId: string): void;
  /** Clear failure count after a successful publish (restores availability). */
  clearEntityFailure?(entityId: string): void;
}

export class UnsupportedEntityTypeError extends Error {
  constructor(type: string) {
    super(`No transport supports entity type: ${type}`);
    this.name = 'UnsupportedEntityTypeError';
  }
}

export class TransportRouter {
  private transports: Transport[] = [];

  register(transport: Transport): void {
    this.transports.push(transport);
  }

  resolve(type: EntityType): Transport {
    const t = this.transports.find((t) => t.supports(type));
    if (!t) throw new UnsupportedEntityTypeError(type);
    return t;
  }
}

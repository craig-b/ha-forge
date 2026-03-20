import type { EntityType } from '@ha-ts-entities/sdk';
import type { ResolvedEntity } from '@ha-ts-entities/sdk/internal';

export interface Transport {
  supports(type: EntityType): boolean;
  register(entity: ResolvedEntity): Promise<void>;
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

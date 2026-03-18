import type { EntityType, ResolvedEntity } from '@ha-ts-entities/sdk';

export interface Transport {
  supports(type: EntityType): boolean;
  register(entity: ResolvedEntity): Promise<void>;
  publishState(entityId: string, state: unknown, attributes?: Record<string, unknown>): Promise<void>;
  onCommand(entityId: string, handler: (command: unknown) => void): void;
  deregister(entityId: string): Promise<void>;
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

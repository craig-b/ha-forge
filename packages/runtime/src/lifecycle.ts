import type {
  EntityContext,
  EntityDefinition,
  EntityLogger,
  ResolvedEntity,
} from '@ha-ts-entities/sdk';
import type { Transport } from './transport.js';

export interface LifecycleLogger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

interface EntityInstance {
  entity: ResolvedEntity;
  handles: TrackedHandles;
  currentState: unknown;
  initialized: boolean;
}

interface TrackedHandles {
  timeouts: ReturnType<typeof globalThis.setTimeout>[];
  intervals: ReturnType<typeof globalThis.setInterval>[];
  pollIntervals: ReturnType<typeof globalThis.setInterval>[];
  mqttSubscriptions: string[];
}

function createEmptyHandles(): TrackedHandles {
  return {
    timeouts: [],
    intervals: [],
    pollIntervals: [],
    mqttSubscriptions: [],
  };
}

export class EntityLifecycleManager {
  private instances = new Map<string, EntityInstance>();
  private transport: Transport;
  private logger: LifecycleLogger;

  constructor(transport: Transport, logger: LifecycleLogger) {
    this.transport = transport;
    this.logger = logger;
  }

  async deploy(entities: ResolvedEntity[]): Promise<void> {
    // Teardown existing entities
    await this.teardownAll();

    // Register and init new entities
    for (const entity of entities) {
      try {
        await this.registerAndInit(entity);
      } catch (err) {
        this.logger.error(`Failed to initialize entity ${entity.definition.id}`, {
          error: err instanceof Error ? err.message : String(err),
          sourceFile: entity.sourceFile,
        });
      }
    }
  }

  private async registerAndInit(entity: ResolvedEntity): Promise<void> {
    const handles = createEmptyHandles();
    const instance: EntityInstance = {
      entity,
      handles,
      currentState: undefined,
      initialized: false,
    };

    this.instances.set(entity.definition.id, instance);

    // Register with transport (publishes MQTT discovery)
    await this.transport.register(entity);

    // Set up command handler for bidirectional entities
    if ('onCommand' in entity.definition && typeof entity.definition.onCommand === 'function') {
      const def = entity.definition as EntityDefinition & {
        onCommand: (this: EntityContext, command: unknown) => void | Promise<void>;
      };
      const context = this.createContext(instance);
      this.transport.onCommand(entity.definition.id, (command) => {
        try {
          def.onCommand.call(context, command);
        } catch (err) {
          this.logger.error(`Command handler error for ${entity.definition.id}`, {
            error: err instanceof Error ? err.message : String(err),
            command,
          });
        }
      });
    }

    // Call init()
    if (entity.definition.init) {
      const context = this.createContext(instance);
      try {
        const initialState = await entity.definition.init.call(context);
        if (initialState !== undefined) {
          instance.currentState = initialState;
          await this.transport.publishState(entity.definition.id, initialState);
        }
        instance.initialized = true;
        this.logger.info(`Entity initialized: ${entity.definition.id}`, {
          sourceFile: entity.sourceFile,
        });
      } catch (err) {
        this.logger.error(`init() failed for ${entity.definition.id}`, {
          error: err instanceof Error ? err.message : String(err),
          sourceFile: entity.sourceFile,
        });
        // Clean up the failed entity
        await this.teardown(entity.definition.id);
        throw err;
      }
    } else {
      instance.initialized = true;
      this.logger.info(`Entity registered: ${entity.definition.id} (no init)`, {
        sourceFile: entity.sourceFile,
      });
    }
  }

  async teardownAll(): Promise<void> {
    const ids = [...this.instances.keys()];
    for (const id of ids) {
      await this.teardown(id);
    }
  }

  private async teardown(entityId: string): Promise<void> {
    const instance = this.instances.get(entityId);
    if (!instance) return;

    // Call destroy() if present
    if (instance.entity.definition.destroy && instance.initialized) {
      try {
        const context = this.createContext(instance);
        await instance.entity.definition.destroy.call(context);
      } catch (err) {
        this.logger.error(`destroy() failed for ${entityId}`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Force-dispose all tracked handles
    this.disposeHandles(instance.handles);

    // Deregister from transport
    try {
      await this.transport.deregister(entityId);
    } catch (err) {
      this.logger.error(`Deregister failed for ${entityId}`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    this.instances.delete(entityId);
  }

  private disposeHandles(handles: TrackedHandles): void {
    for (const t of handles.timeouts) clearTimeout(t);
    for (const i of handles.intervals) clearInterval(i);
    for (const p of handles.pollIntervals) clearInterval(p);
    handles.timeouts = [];
    handles.intervals = [];
    handles.pollIntervals = [];
    handles.mqttSubscriptions = [];
  }

  private createContext(instance: EntityInstance): EntityContext {
    const { entity, handles } = instance;
    const transport = this.transport;
    const logger = this.logger;
    const entityId = entity.definition.id;

    const entityLogger: EntityLogger = {
      debug: (msg, data) => logger.debug(`[${entityId}] ${msg}`, data),
      info: (msg, data) => logger.info(`[${entityId}] ${msg}`, data),
      warn: (msg, data) => logger.warn(`[${entityId}] ${msg}`, data),
      error: (msg, data) => logger.error(`[${entityId}] ${msg}`, data),
    };

    const context: EntityContext = {
      update(value: unknown, attributes?: Record<string, unknown>) {
        instance.currentState = value;
        transport.publishState(entityId, value, attributes).catch((err) => {
          entityLogger.error('Failed to publish state', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      },

      poll(fn: () => unknown | Promise<unknown>, opts: { interval: number }) {
        const interval = globalThis.setInterval(async () => {
          try {
            const value = await fn();
            if (value !== undefined) {
              context.update(value);
            }
          } catch (err) {
            entityLogger.error('Poll error', {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }, opts.interval);
        handles.pollIntervals.push(interval);
      },

      log: entityLogger,

      setTimeout(fn: () => void, ms: number) {
        const t = globalThis.setTimeout(fn, ms);
        handles.timeouts.push(t);
      },

      setInterval(fn: () => void, ms: number) {
        const i = globalThis.setInterval(fn, ms);
        handles.intervals.push(i);
      },

      fetch: globalThis.fetch,

      mqtt: {
        publish(_topic, _payload, _opts) {
          entityLogger.warn('Direct MQTT publish not yet implemented');
        },
        subscribe(_topic, _handler) {
          entityLogger.warn('Direct MQTT subscribe not yet implemented');
        },
      },
    };

    return context;
  }

  getEntityState(entityId: string): unknown {
    return this.instances.get(entityId)?.currentState;
  }

  getEntityIds(): string[] {
    return [...this.instances.keys()];
  }

  isInitialized(entityId: string): boolean {
    return this.instances.get(entityId)?.initialized ?? false;
  }
}

import type {
  DeviceContext,
  DeviceDefinition,
  EntityContext,
  EntityDefinition,
  EntityLogger,
  ResolvedEntity,
} from '@ha-ts-entities/sdk';
import type { HAClient } from './ha-api.js';
import type { ResolvedDevice } from './loader.js';
import type { Transport } from './transport.js';

export interface LifecycleLogger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
  forEntity?(entityId: string, sourceFile?: string): LifecycleLogger;
}

interface EntityInstance {
  entity: ResolvedEntity;
  handles: TrackedHandles;
  currentState: unknown;
  initialized: boolean;
  /** Entity IDs owned by a device skip individual init/destroy. */
  ownedByDevice?: string;
}

interface DeviceInstance {
  device: ResolvedDevice;
  handles: TrackedHandles;
  initialized: boolean;
  /** Command handlers registered via entity handles. */
  commandHandlers: Map<string, (command: unknown) => void | Promise<void>>;
  /** Stored context for calling destroy(). */
  context?: DeviceContext<Record<string, EntityDefinition>>;
}

interface PollRef {
  timer: ReturnType<typeof globalThis.setTimeout> | null;
}

interface TrackedHandles {
  timeouts: ReturnType<typeof globalThis.setTimeout>[];
  intervals: ReturnType<typeof globalThis.setInterval>[];
  pollRefs: PollRef[];
  mqttSubscriptions: Array<() => void>;
}

/** Raw MQTT access for entity context. */
export interface RawMqttAccess {
  publishRaw(topic: string, payload: string, opts?: { retain?: boolean }): void;
  subscribeRaw(topic: string, handler: (payload: string) => void): () => void;
}

function createEmptyHandles(): TrackedHandles {
  return {
    timeouts: [],
    intervals: [],
    pollRefs: [],
    mqttSubscriptions: [],
  };
}

export class EntityLifecycleManager {
  private instances = new Map<string, EntityInstance>();
  private deviceInstances = new Map<string, DeviceInstance>();
  private transport: Transport;
  private logger: LifecycleLogger;
  private haClient: HAClient | null;
  private rawMqtt: RawMqttAccess | null;

  constructor(transport: Transport, logger: LifecycleLogger, haClient?: HAClient | null, rawMqtt?: RawMqttAccess | null) {
    this.transport = transport;
    this.logger = logger;
    this.haClient = haClient ?? null;
    this.rawMqtt = rawMqtt ?? null;
  }

  async deploy(entities: ResolvedEntity[], devices?: ResolvedDevice[]): Promise<void> {
    // Full deploy: teardown everything first, then register new entities
    await this.teardownAll();
    await this.deployAdditive(entities, devices);
  }

  /**
   * Register and init entities/devices without tearing down existing ones.
   * Used by BuildManager which handles teardown separately to support per-file isolation.
   */
  async deployAdditive(entities: ResolvedEntity[], devices?: ResolvedDevice[]): Promise<void> {
    // Collect entity IDs owned by devices so we skip individual init for them
    const deviceOwnedEntityIds = new Set<string>();
    if (devices) {
      for (const dev of devices) {
        for (const eid of dev.entityIds) {
          deviceOwnedEntityIds.add(eid);
        }
      }
    }

    // Register and init standalone entities (not owned by a device)
    for (const entity of entities) {
      try {
        await this.registerAndInit(entity, deviceOwnedEntityIds.has(entity.definition.id) ? entity.deviceId : undefined);
      } catch (err) {
        this.logger.error(`Failed to initialize entity ${entity.definition.id}`, {
          error: err instanceof Error ? err.message : String(err),
          sourceFile: entity.sourceFile,
        });
      }
    }

    // Init devices (their entities are already registered above)
    if (devices) {
      for (const dev of devices) {
        try {
          await this.initDevice(dev);
        } catch (err) {
          this.logger.error(`Failed to initialize device ${dev.definition.id}`, {
            error: err instanceof Error ? err.message : String(err),
            sourceFile: dev.sourceFile,
          });
        }
      }
    }
  }

  private async registerAndInit(entity: ResolvedEntity, ownedByDevice?: string): Promise<void> {
    const handles = createEmptyHandles();
    const instance: EntityInstance = {
      entity,
      handles,
      currentState: undefined,
      initialized: false,
      ownedByDevice,
    };

    this.instances.set(entity.definition.id, instance);

    // Register with transport (publishes MQTT discovery)
    await this.transport.register(entity);

    // Device-owned entities: skip individual init and command registration.
    // The device's init() will set up command handlers via entity handles.
    if (ownedByDevice) {
      instance.initialized = true;
      this.logger.info(`Entity registered (device ${ownedByDevice}): ${entity.definition.id}`, {
        sourceFile: entity.sourceFile,
      });
      return;
    }

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
        const initFn = entity.definition.init as (this: EntityContext) => unknown | Promise<unknown>;
        const initialState = await initFn.call(context);
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

  private async initDevice(resolvedDevice: ResolvedDevice): Promise<void> {
    const dev = resolvedDevice.definition;
    const handles = createEmptyHandles();
    const commandHandlers = new Map<string, (command: unknown) => void | Promise<void>>();

    const deviceInstance: DeviceInstance = {
      device: resolvedDevice,
      handles,
      initialized: false,
      commandHandlers,
    };

    this.deviceInstances.set(dev.id, deviceInstance);

    // Build entity handles for the device context
    const entityHandles: Record<string, { update: (value: unknown, attributes?: Record<string, unknown>) => void; onCommand?: (handler: (command: unknown) => void | Promise<void>) => void }> = {};

    for (const [key, entityDef] of Object.entries(dev.entities)) {
      const entityId = entityDef.id;
      const entityInstance = this.instances.get(entityId);
      if (!entityInstance) {
        this.logger.warn(`Device ${dev.id}: entity ${entityId} not found in instances`);
        continue;
      }

      const handle: { update: (value: unknown, attributes?: Record<string, unknown>) => void; onCommand?: (handler: (command: unknown) => void | Promise<void>) => void } = {
        update: (value: unknown, attributes?: Record<string, unknown>) => {
          entityInstance.currentState = value;
          this.transport.publishState(entityId, value, attributes).catch((err) => {
            this.logger.error(`Failed to publish state for ${entityId}`, {
              error: err instanceof Error ? err.message : String(err),
            });
          });
        },
      };

      // Add onCommand for bidirectional entity types
      if (entityDef.type === 'switch' || entityDef.type === 'light' || entityDef.type === 'cover' || entityDef.type === 'climate') {
        handle.onCommand = (handler: (command: unknown) => void | Promise<void>) => {
          commandHandlers.set(entityId, handler);
        };

        // Register transport command listener that delegates to the device's handler
        this.transport.onCommand(entityId, (command) => {
          const h = commandHandlers.get(entityId);
          if (h) {
            try {
              const result = h(command);
              if (result instanceof Promise) {
                result.catch((err) => {
                  this.logger.error(`Command handler error for ${entityId}`, {
                    error: err instanceof Error ? err.message : String(err),
                    command,
                  });
                });
              }
            } catch (err) {
              this.logger.error(`Command handler error for ${entityId}`, {
                error: err instanceof Error ? err.message : String(err),
                command,
              });
            }
          } else {
            this.logger.warn(`No command handler registered for ${entityId} in device ${dev.id}`);
          }
        });
      }

      entityHandles[key] = handle;
    }

    // Build the device context
    const scopedLogger = this.logger.forEntity
      ? this.logger.forEntity(dev.id, resolvedDevice.sourceFile)
      : this.logger;

    const entityLogger: EntityLogger = {
      debug: (msg, data) => scopedLogger.debug(msg, data),
      info: (msg, data) => scopedLogger.info(msg, data),
      warn: (msg, data) => scopedLogger.warn(msg, data),
      error: (msg, data) => scopedLogger.error(msg, data),
    };

    const haClient = this.haClient;
    const rawMqtt = this.rawMqtt;

    const ha: HAClient = haClient ?? {
      log: entityLogger,
      on() { entityLogger.warn('ha.on() unavailable — no WebSocket connection'); return () => {}; },
      async callService() { entityLogger.warn('ha.callService() unavailable — no WebSocket connection'); return null; },
      async getState() { entityLogger.warn('ha.getState() unavailable — no WebSocket connection'); return null; },
      async getEntities() { entityLogger.warn('ha.getEntities() unavailable — no WebSocket connection'); return []; },
      async fireEvent() { entityLogger.warn('ha.fireEvent() unavailable — no WebSocket connection'); },
      reactions() { entityLogger.warn('ha.reactions() unavailable — no WebSocket connection'); return () => {}; },
      friendlyName(entityId: string) { return entityId; },
    };

    const context: DeviceContext<Record<string, EntityDefinition>> = {
      entities: entityHandles as DeviceContext<Record<string, EntityDefinition>>['entities'],

      poll(fn: () => void | Promise<void>, opts: { interval: number; initialDelay?: number }) {
        const run = async () => {
          try {
            await fn();
          } catch (err) {
            entityLogger.error('Device poll error', {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        };
        // Chained timeouts: wait for completion, then schedule next.
        // Prevents overlapping executions when callback takes longer than interval.
        const ref: { timer: ReturnType<typeof globalThis.setTimeout> | null } = { timer: null };
        const scheduleNext = () => {
          ref.timer = globalThis.setTimeout(async () => {
            await run();
            scheduleNext();
          }, opts.interval);
        };
        const startPolling = async () => {
          await run();
          scheduleNext();
        };
        // Track ref for cleanup — pollRefs checked in disposeHandles
        handles.pollRefs.push(ref);
        if (opts.initialDelay) {
          const t = globalThis.setTimeout(startPolling, opts.initialDelay);
          handles.timeouts.push(t);
        } else {
          startPolling();
        }
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
      ha,

      mqtt: {
        publish(topic, payload, opts) {
          if (!rawMqtt) { entityLogger.warn('mqtt.publish() unavailable — no MQTT connection'); return; }
          rawMqtt.publishRaw(topic, payload, opts);
        },
        subscribe(topic, handler) {
          if (!rawMqtt) { entityLogger.warn('mqtt.subscribe() unavailable — no MQTT connection'); return; }
          const unsub = rawMqtt.subscribeRaw(topic, handler);
          handles.mqttSubscriptions.push(unsub);
        },
      },
    };

    // Store context for destroy()
    deviceInstance.context = context;

    // Call device init()
    try {
      await dev.init.call(context);
      deviceInstance.initialized = true;
      this.logger.info(`Device initialized: ${dev.id}`, {
        sourceFile: resolvedDevice.sourceFile,
        entityCount: resolvedDevice.entityIds.length,
      });
    } catch (err) {
      this.logger.error(`Device init() failed for ${dev.id}`, {
        error: err instanceof Error ? err.message : String(err),
        sourceFile: resolvedDevice.sourceFile,
      });
      this.disposeHandles(handles);
      this.deviceInstances.delete(dev.id);
      throw err;
    }
  }

  async teardownAll(): Promise<void> {
    // Teardown devices first (they may reference entity instances)
    for (const [deviceId, deviceInstance] of this.deviceInstances) {
      if (deviceInstance.device.definition.destroy && deviceInstance.initialized && deviceInstance.context) {
        try {
          await deviceInstance.device.definition.destroy.call(deviceInstance.context);
        } catch (err) {
          this.logger.error(`Device destroy() failed for ${deviceId}`, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      this.disposeHandles(deviceInstance.handles);
    }
    this.deviceInstances.clear();

    // Then teardown all entities
    const ids = [...this.instances.keys()];
    for (const id of ids) {
      await this.teardown(id);
    }
  }

  private async teardown(entityId: string): Promise<void> {
    const instance = this.instances.get(entityId);
    if (!instance) return;

    // Call destroy() if present (skip for device-owned entities — device handles its own teardown)
    if (instance.entity.definition.destroy && instance.initialized && !instance.ownedByDevice) {
      try {
        const context = this.createContext(instance);
        const destroyFn = instance.entity.definition.destroy as (this: EntityContext) => void | Promise<void>;
        await destroyFn.call(context);
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
    for (const ref of handles.pollRefs) {
      if (ref.timer) clearTimeout(ref.timer);
    }
    for (const unsub of handles.mqttSubscriptions) unsub();
    handles.timeouts = [];
    handles.intervals = [];
    handles.pollRefs = [];
    handles.mqttSubscriptions = [];
  }

  private createContext(instance: EntityInstance): EntityContext {
    const { entity, handles } = instance;
    const transport = this.transport;
    const logger = this.logger;
    const haClient = this.haClient;
    const rawMqtt = this.rawMqtt;
    const entityId = entity.definition.id;

    // Use scoped child logger if available (SQLiteLogger), otherwise prefix messages
    const scopedLogger = logger.forEntity
      ? logger.forEntity(entityId, entity.sourceFile)
      : logger;

    const entityLogger: EntityLogger = {
      debug: (msg, data) => scopedLogger.debug(msg, data),
      info: (msg, data) => scopedLogger.info(msg, data),
      warn: (msg, data) => scopedLogger.warn(msg, data),
      error: (msg, data) => scopedLogger.error(msg, data),
    };

    // Build ha API — delegates to the shared HAClient, or stubs if unavailable
    const ha: HAClient = haClient ?? {
      log: entityLogger,
      on() {
        entityLogger.warn('ha.on() unavailable — no WebSocket connection');
        return () => {};
      },
      async callService() {
        entityLogger.warn('ha.callService() unavailable — no WebSocket connection');
        return null;
      },
      async getState() {
        entityLogger.warn('ha.getState() unavailable — no WebSocket connection');
        return null;
      },
      async getEntities() {
        entityLogger.warn('ha.getEntities() unavailable — no WebSocket connection');
        return [];
      },
      async fireEvent() {
        entityLogger.warn('ha.fireEvent() unavailable — no WebSocket connection');
      },
      reactions() {
        entityLogger.warn('ha.reactions() unavailable — no WebSocket connection');
        return () => {};
      },
      friendlyName(entityId: string) {
        entityLogger.warn('ha.friendlyName() unavailable — no WebSocket connection');
        return entityId;
      },
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

      poll(fn: () => unknown | Promise<unknown>, opts: { interval: number; initialDelay?: number }) {
        const run = async () => {
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
        };
        const ref: { timer: ReturnType<typeof globalThis.setTimeout> | null } = { timer: null };
        const scheduleNext = () => {
          ref.timer = globalThis.setTimeout(async () => {
            await run();
            scheduleNext();
          }, opts.interval);
        };
        const startPolling = async () => {
          await run();
          scheduleNext();
        };
        handles.pollRefs.push(ref);
        if (opts.initialDelay) {
          const t = globalThis.setTimeout(startPolling, opts.initialDelay);
          handles.timeouts.push(t);
        } else {
          startPolling();
        }
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

      ha,

      mqtt: {
        publish(topic, payload, opts) {
          if (!rawMqtt) {
            entityLogger.warn('mqtt.publish() unavailable — no MQTT connection');
            return;
          }
          rawMqtt.publishRaw(topic, payload, opts);
        },
        subscribe(topic, handler) {
          if (!rawMqtt) {
            entityLogger.warn('mqtt.subscribe() unavailable — no MQTT connection');
            return;
          }
          const unsub = rawMqtt.subscribeRaw(topic, handler);
          handles.mqttSubscriptions.push(unsub);
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

  getEntityInfo(entityId: string): { type: string; name: string; sourceFile: string } | undefined {
    const instance = this.instances.get(entityId);
    if (!instance) return undefined;
    return {
      type: instance.entity.definition.type,
      name: instance.entity.definition.name || entityId,
      sourceFile: instance.entity.sourceFile,
    };
  }

  isInitialized(entityId: string): boolean {
    return this.instances.get(entityId)?.initialized ?? false;
  }
}

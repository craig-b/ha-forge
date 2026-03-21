import type {
  AutomationContext,
  AutomationDefinition,
  ComputedAttribute,
  ComputedDefinition,
  DeviceContext,
  DeviceDefinition,
  EntityContext,
  EntityDefinition,
  EntityLogger,
  EntitySnapshot,
  EventsContext,
  ModeContext,
  ModeDefinition,
  EventStream,
  StatelessHAApi,
  TaskContext,
  TaskDefinition,
} from '@ha-forge/sdk';
import { createEventStream } from '@ha-forge/sdk';
import type { ResolvedEntity } from '@ha-forge/sdk/internal';
import type { ResolvedAutomation, ResolvedDevice, ResolvedMode, ResolvedTask } from './loader.js';
import type { Transport } from './transport.js';
import type { HAApiImpl } from './ha-api.js';

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

interface AutomationInstance {
  automation: ResolvedAutomation;
  handles: TrackedHandles;
  initialized: boolean;
  /** Stored context for calling destroy(). */
  context?: AutomationContext;
}

interface TaskInstance {
  task: ResolvedTask;
  handles: TrackedHandles;
  /** Whether the task is currently executing run(). */
  running: boolean;
}

interface ModeInstance {
  mode: ResolvedMode;
  handles: TrackedHandles;
  /** Current mode state. */
  currentState: string;
  initialized: boolean;
}

interface PollRef {
  timer: ReturnType<typeof globalThis.setTimeout> | null;
}

interface TrackedHandles {
  timeouts: ReturnType<typeof globalThis.setTimeout>[];
  intervals: ReturnType<typeof globalThis.setInterval>[];
  pollRefs: PollRef[];
  mqttSubscriptions: Array<() => void>;
  eventSubscriptions: Array<() => void>;
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
    eventSubscriptions: [],
  };
}

function isComputedAttribute(value: unknown): value is ComputedAttribute {
  return (
    typeof value === 'object' &&
    value !== null &&
    '__computedAttr' in value &&
    (value as Record<string, unknown>).__computedAttr === true
  );
}

export class EntityLifecycleManager {
  private instances = new Map<string, EntityInstance>();
  private deviceInstances = new Map<string, DeviceInstance>();
  private automationInstances = new Map<string, AutomationInstance>();
  private taskInstances = new Map<string, TaskInstance>();
  private modeInstances = new Map<string, ModeInstance>();
  private transport: Transport;
  private logger: LifecycleLogger;
  private rawMqtt: RawMqttAccess | null;
  private onStateChange: ((entityId: string, state: unknown) => void) | null;
  private haApi: HAApiImpl | null;

  constructor(transport: Transport, logger: LifecycleLogger, rawMqtt?: RawMqttAccess | null, onStateChange?: (entityId: string, state: unknown) => void, haApi?: HAApiImpl | null) {
    this.transport = transport;
    this.logger = logger;
    this.rawMqtt = rawMqtt ?? null;
    this.onStateChange = onStateChange ?? null;
    this.haApi = haApi ?? null;
  }

  async deploy(entities: ResolvedEntity[], devices?: ResolvedDevice[], automations?: ResolvedAutomation[], tasks?: ResolvedTask[], modes?: ResolvedMode[]): Promise<void> {
    // Full deploy: teardown everything first, then register new entities
    await this.teardownAll();
    await this.deployAdditive(entities, devices, automations, tasks, modes);
  }

  /**
   * Register and init entities/devices/automations/tasks without tearing down existing ones.
   * Used by BuildManager which handles teardown separately to support per-file isolation.
   */
  async deployAdditive(entities: ResolvedEntity[], devices?: ResolvedDevice[], automations?: ResolvedAutomation[], tasks?: ResolvedTask[], modes?: ResolvedMode[]): Promise<void> {
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

    // Init automations
    if (automations) {
      for (const auto of automations) {
        try {
          await this.initAutomation(auto);
        } catch (err) {
          this.logger.error(`Failed to initialize automation ${auto.definition.id}`, {
            error: err instanceof Error ? err.message : String(err),
            sourceFile: auto.sourceFile,
          });
        }
      }
    }

    // Init tasks
    if (tasks) {
      for (const t of tasks) {
        try {
          await this.initTask(t);
        } catch (err) {
          this.logger.error(`Failed to initialize task ${t.definition.id}`, {
            error: err instanceof Error ? err.message : String(err),
            sourceFile: t.sourceFile,
          });
        }
      }
    }

    // Init modes
    if (modes) {
      for (const m of modes) {
        try {
          await this.initMode(m);
        } catch (err) {
          this.logger.error(`Failed to initialize mode ${m.definition.id}`, {
            error: err instanceof Error ? err.message : String(err),
            sourceFile: m.sourceFile,
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

    // Computed entities: auto-subscribe to watched entities, no user init
    if ('__computed' in entity.definition && (entity.definition as ComputedDefinition).__computed === true) {
      await this.initComputed(instance, entity.definition as ComputedDefinition);
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

    // Set up press handler for button entities
    if ('onPress' in entity.definition && typeof entity.definition.onPress === 'function') {
      const def = entity.definition as EntityDefinition & {
        onPress: (this: EntityContext) => void | Promise<void>;
      };
      const context = this.createContext(instance);
      this.transport.onCommand(entity.definition.id, () => {
        try {
          def.onPress.call(context);
        } catch (err) {
          this.logger.error(`Press handler error for ${entity.definition.id}`, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });
    }

    // Set up notify handler for notify entities
    if ('onNotify' in entity.definition && typeof entity.definition.onNotify === 'function') {
      const def = entity.definition as EntityDefinition & {
        onNotify: (this: EntityContext, message: string) => void | Promise<void>;
      };
      const context = this.createContext(instance);
      this.transport.onCommand(entity.definition.id, (command) => {
        try {
          def.onNotify.call(context, String(command));
        } catch (err) {
          this.logger.error(`Notify handler error for ${entity.definition.id}`, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });
    }

    // Set up install handler for update entities
    if ('onInstall' in entity.definition && typeof entity.definition.onInstall === 'function') {
      const def = entity.definition as EntityDefinition & {
        onInstall: (this: EntityContext) => void | Promise<void>;
      };
      const context = this.createContext(instance);
      this.transport.onCommand(entity.definition.id, () => {
        try {
          def.onInstall.call(context);
        } catch (err) {
          this.logger.error(`Install handler error for ${entity.definition.id}`, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });
    }

    // Call init()
    if ('init' in entity.definition && entity.definition.init) {
      const context = this.createContext(instance);
      try {
        const initFn = entity.definition.init as (this: EntityContext) => unknown | Promise<unknown>;
        const initialState = await initFn.call(context);
        if (initialState !== undefined) {
          instance.currentState = initialState;
          await this.transport.publishState(entity.definition.id, initialState);
          this.transport.clearEntityFailure?.(entity.definition.id);
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

    // Wire up computed attributes (reactive attribute values)
    this.initComputedAttributes(instance);
  }

  private async initComputed(instance: EntityInstance, def: ComputedDefinition): Promise<void> {
    const { handles, entity } = instance;
    const haApi = this.haApi;
    const transport = this.transport;
    const logger = this.logger;
    const onStateChange = this.onStateChange;

    if (!haApi) {
      logger.warn(`Computed entity ${def.id}: no WebSocket connection, cannot subscribe to watched entities`);
      instance.initialized = true;
      return;
    }

    const entityId = def.id;
    const debounceMs = def.debounce ?? 100;

    const buildSnapshot = (): Record<string, EntitySnapshot | null> => {
      const states: Record<string, EntitySnapshot | null> = {};
      for (const eid of def.watch) {
        states[eid] = haApi.getCachedSnapshot(eid);
      }
      return states;
    };

    const evaluate = async () => {
      try {
        const states = buildSnapshot();
        const newValue = def.compute(states);
        // Deduplicate — only publish when value actually differs
        if (String(newValue) !== String(instance.currentState)) {
          instance.currentState = newValue;
          await transport.publishState(entityId, newValue);
          transport.clearEntityFailure?.(entityId);
          onStateChange?.(entityId, newValue);
        }
      } catch (err) {
        transport.recordEntityFailure?.(entityId);
        logger.error(`Computed entity ${entityId}: compute() failed`, {
          error: err instanceof Error ? err.message : String(err),
          sourceFile: entity.sourceFile,
        });
      }
    };

    // Set up debounced subscription to watched entities
    let pending: ReturnType<typeof globalThis.setTimeout> | null = null;
    const debouncedEvaluate = () => {
      if (pending !== null) clearTimeout(pending);
      if (debounceMs <= 0) {
        evaluate();
      } else {
        pending = globalThis.setTimeout(() => {
          pending = null;
          evaluate();
        }, debounceMs);
      }
    };

    const unsub = haApi.on(def.watch, debouncedEvaluate);
    handles.eventSubscriptions.push(() => {
      unsub();
      if (pending !== null) clearTimeout(pending);
    });

    // Run initial evaluation
    await evaluate();

    instance.initialized = true;
    logger.info(`Computed entity initialized: ${entityId} (watching ${def.watch.length} entities)`, {
      sourceFile: entity.sourceFile,
    });
  }

  /**
   * Scan an entity's `attributes` for ComputedAttribute markers and wire up
   * reactive subscriptions that re-publish attributes when watched entities change.
   */
  private initComputedAttributes(instance: EntityInstance): void {
    const def = instance.entity.definition as EntityDefinition & { attributes?: Record<string, unknown> };
    if (!def.attributes) return;

    const haApi = this.haApi;
    if (!haApi) return;

    const transport = this.transport;
    const logger = this.logger;
    const entityId = def.id;
    const { handles } = instance;

    // Collect computed attribute entries
    const computedAttrs: Array<{ key: string; attr: ComputedAttribute }> = [];
    for (const [key, value] of Object.entries(def.attributes)) {
      if (isComputedAttribute(value)) {
        computedAttrs.push({ key, attr: value });
      }
    }

    if (computedAttrs.length === 0) return;

    // Collect all unique watch targets across all computed attributes
    const allWatchTargets = new Set<string>();
    for (const { attr } of computedAttrs) {
      for (const eid of attr.watch) allWatchTargets.add(eid);
    }

    // Build merged attributes (static + computed) and publish
    const evaluateAttributes = () => {
      try {
        const attrs: Record<string, unknown> = {};

        // Static attributes first
        for (const [key, value] of Object.entries(def.attributes!)) {
          if (!isComputedAttribute(value)) {
            attrs[key] = value;
          }
        }

        // Evaluate computed attributes
        for (const { key, attr } of computedAttrs) {
          const states: Record<string, EntitySnapshot | null> = {};
          for (const eid of attr.watch) {
            states[eid] = haApi.getCachedSnapshot(eid);
          }
          attrs[key] = attr.compute(states);
        }

        // Re-publish current state with updated attributes
        transport.publishState(entityId, instance.currentState, attrs).catch(() => {});
      } catch (err) {
        logger.error(`Computed attributes failed for ${entityId}`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };

    // Use the finest debounce across all computed attributes (default 100ms)
    const debounceMs = Math.min(...computedAttrs.map(({ attr }) => attr.debounce ?? 100));
    let pending: ReturnType<typeof globalThis.setTimeout> | null = null;
    const debouncedEvaluate = () => {
      if (pending !== null) clearTimeout(pending);
      if (debounceMs <= 0) {
        evaluateAttributes();
      } else {
        pending = globalThis.setTimeout(() => {
          pending = null;
          evaluateAttributes();
        }, debounceMs);
      }
    };

    // Subscribe to all watched entities
    const unsub = haApi.on([...allWatchTargets], debouncedEvaluate);
    handles.eventSubscriptions.push(() => {
      unsub();
      if (pending !== null) clearTimeout(pending);
    });

    // Initial evaluation
    evaluateAttributes();

    logger.debug(`Computed attributes wired for ${entityId}: ${computedAttrs.map(c => c.key).join(', ')}`);
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
          this.transport.publishState(entityId, value, attributes).then(() => {
            this.transport.clearEntityFailure?.(entityId);
            this.onStateChange?.(entityId, value);
          }).catch((err) => {
            this.transport.recordEntityFailure?.(entityId);
            this.logger.error(`Failed to publish state for ${entityId}`, {
              error: err instanceof Error ? err.message : String(err),
            });
          });
        },
      };

      // Add onCommand for bidirectional entity types
      if ('onCommand' in entityDef) {
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

    const rawMqtt = this.rawMqtt;
    const haApi = this.haApi;

    const stubStatelessApi: StatelessHAApi = {
      async callService() { entityLogger.warn('this.ha.callService() unavailable — no WebSocket connection'); return null; },
      async getState() { entityLogger.warn('this.ha.getState() unavailable — no WebSocket connection'); return null; },
      async getEntities() { entityLogger.warn('this.ha.getEntities() unavailable — no WebSocket connection'); return []; },
      async fireEvent() { entityLogger.warn('this.ha.fireEvent() unavailable — no WebSocket connection'); },
      friendlyName(id: string) { return id; },
    };

    const stubEvents: EventsContext = {
      on() { entityLogger.warn('this.events.on() unavailable — no WebSocket connection'); return createEventStream(() => () => {}); },
      reactions() { entityLogger.warn('this.events.reactions() unavailable — no WebSocket connection'); return () => {}; },
      combine() { entityLogger.warn('this.events.combine() unavailable — no WebSocket connection'); return () => {}; },
      withState() { entityLogger.warn('this.events.withState() unavailable — no WebSocket connection'); return createEventStream(() => () => {}); },
      watchdog() { entityLogger.warn('this.events.watchdog() unavailable — no WebSocket connection'); return () => {}; },
      invariant() { entityLogger.warn('this.events.invariant() unavailable — no WebSocket connection'); return () => {}; },
      sequence() { entityLogger.warn('this.events.sequence() unavailable — no WebSocket connection'); return () => {}; },
    };

    const context: DeviceContext<Record<string, EntityDefinition>> = {
      entities: entityHandles as DeviceContext<Record<string, EntityDefinition>>['entities'],

      ha: haApi ? haApi.asStateless() : stubStatelessApi,
      events: haApi ? haApi.createScopedEvents(handles) : stubEvents,

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

  private async initAutomation(resolved: ResolvedAutomation): Promise<void> {
    const def = resolved.definition;
    const handles = createEmptyHandles();

    const instance: AutomationInstance = {
      automation: resolved,
      handles,
      initialized: false,
    };

    this.automationInstances.set(def.id, instance);

    // If entity: true, register a binary_sensor to track automation state
    if (def.entity) {
      const syntheticEntity: ResolvedEntity = {
        definition: {
          id: def.id,
          name: def.id,
          type: 'binary_sensor',
          config: { device_class: 'running' },
        } as EntityDefinition,
        sourceFile: resolved.sourceFile,
        deviceId: def.id,
      };
      await this.transport.register(syntheticEntity);
    }

    const context = this.createAutomationContext(instance);
    instance.context = context;

    try {
      await def.init.call(context);
      instance.initialized = true;

      if (def.entity) {
        await this.transport.publishState(def.id, 'ON');
      }

      this.logger.info(`Automation initialized: ${def.id}`, {
        sourceFile: resolved.sourceFile,
      });
    } catch (err) {
      if (def.entity) {
        await this.transport.publishState(def.id, 'OFF').catch(() => {});
      }
      this.logger.error(`Automation init() failed for ${def.id}`, {
        error: err instanceof Error ? err.message : String(err),
        sourceFile: resolved.sourceFile,
      });
      this.disposeHandles(handles);
      this.automationInstances.delete(def.id);
      throw err;
    }
  }

  private async initTask(resolved: ResolvedTask): Promise<void> {
    const def = resolved.definition;
    const handles = createEmptyHandles();

    const instance: TaskInstance = {
      task: resolved,
      handles,
      running: false,
    };

    this.taskInstances.set(def.id, instance);

    // Register a button entity in HA
    const syntheticEntity: ResolvedEntity = {
      definition: {
        id: def.id,
        name: def.name,
        type: 'button',
        ...(def.device && { device: def.device }),
        ...(def.icon && { icon: def.icon }),
      } as unknown as EntityDefinition,
      sourceFile: resolved.sourceFile,
      deviceId: def.device?.id ?? def.id,
    };
    await this.transport.register(syntheticEntity);

    // Set up command handler for button press
    const taskContext = this.createTaskContext(instance);
    this.transport.onCommand(def.id, () => {
      this.executeTask(instance, taskContext);
    });

    this.logger.info(`Task registered: ${def.id}`, {
      sourceFile: resolved.sourceFile,
    });

    // Run on deploy if configured
    if (def.runOnDeploy) {
      this.executeTask(instance, taskContext);
    }
  }

  private executeTask(instance: TaskInstance, context: TaskContext): void {
    if (instance.running) {
      this.logger.warn(`Task ${instance.task.definition.id} is already running, skipping`);
      return;
    }

    instance.running = true;
    const def = instance.task.definition;

    Promise.resolve()
      .then(() => def.run.call(context))
      .then(() => {
        instance.running = false;
        this.logger.info(`Task completed: ${def.id}`);
      })
      .catch((err) => {
        instance.running = false;
        this.logger.error(`Task run() failed for ${def.id}`, {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  private async initMode(resolved: ResolvedMode): Promise<void> {
    const def = resolved.definition;
    const handles = createEmptyHandles();

    const instance: ModeInstance = {
      mode: resolved,
      handles,
      currentState: def.initial,
      initialized: false,
    };

    this.modeInstances.set(def.id, instance);

    // Register a select entity in HA with mode states as options
    const syntheticEntity: ResolvedEntity = {
      definition: {
        id: def.id,
        name: def.name,
        type: 'select',
        config: { options: [...def.states] },
        ...(def.device && { device: def.device }),
        ...(def.icon && { icon: def.icon }),
      } as unknown as EntityDefinition,
      sourceFile: resolved.sourceFile,
      deviceId: def.device?.id ?? def.id,
    };
    await this.transport.register(syntheticEntity);

    // Publish initial state
    await this.transport.publishState(def.id, def.initial);
    this.onStateChange?.(def.id, def.initial);

    // Create context for transition callbacks
    const modeContext = this.createModeContext(instance);

    // Run enter hook for initial state
    const initialTransition = def.transitions?.[def.initial];
    if (initialTransition?.enter) {
      try {
        await initialTransition.enter.call(modeContext);
      } catch (err) {
        this.logger.error(`Mode ${def.id}: enter(${def.initial}) failed`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Handle select commands (state transitions)
    this.transport.onCommand(def.id, async (command) => {
      const targetState = String(command);

      if (!def.states.includes(targetState as typeof def.states[number])) {
        this.logger.warn(`Mode ${def.id}: invalid state '${targetState}'`);
        return;
      }

      if (targetState === instance.currentState) return;

      const fromState = instance.currentState;

      // Check guard on target state
      const targetTransition = def.transitions?.[targetState as typeof def.states[number]];
      if (targetTransition?.guard) {
        try {
          const allowed = await targetTransition.guard.call(modeContext, fromState as typeof def.states[number]);
          if (!allowed) {
            this.logger.info(`Mode ${def.id}: guard blocked transition ${fromState} → ${targetState}`);
            // Re-publish current state to revert the UI
            await this.transport.publishState(def.id, fromState);
            return;
          }
        } catch (err) {
          this.logger.error(`Mode ${def.id}: guard(${targetState}) failed`, {
            error: err instanceof Error ? err.message : String(err),
          });
          await this.transport.publishState(def.id, fromState);
          return;
        }
      }

      // Run exit hook for current state
      const currentTransition = def.transitions?.[fromState as typeof def.states[number]];
      if (currentTransition?.exit) {
        try {
          await currentTransition.exit.call(modeContext);
        } catch (err) {
          this.logger.error(`Mode ${def.id}: exit(${fromState}) failed`, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Transition
      instance.currentState = targetState;
      await this.transport.publishState(def.id, targetState);
      this.onStateChange?.(def.id, targetState);

      // Run enter hook for new state
      if (targetTransition?.enter) {
        try {
          await targetTransition.enter.call(modeContext);
        } catch (err) {
          this.logger.error(`Mode ${def.id}: enter(${targetState}) failed`, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    });

    instance.initialized = true;
    this.logger.info(`Mode initialized: ${def.id} (${def.states.length} states, initial: ${def.initial})`, {
      sourceFile: resolved.sourceFile,
    });
  }

  private createModeContext(instance: ModeInstance): ModeContext {
    const haApi = this.haApi;
    const scopedLogger = this.logger.forEntity
      ? this.logger.forEntity(instance.mode.definition.id, instance.mode.sourceFile)
      : this.logger;

    const entityLogger: EntityLogger = {
      debug: (msg, data) => scopedLogger.debug(msg, data),
      info: (msg, data) => scopedLogger.info(msg, data),
      warn: (msg, data) => scopedLogger.warn(msg, data),
      error: (msg, data) => scopedLogger.error(msg, data),
    };

    const stubStatelessApi: StatelessHAApi = {
      async callService() { entityLogger.warn('this.ha.callService() unavailable — no WebSocket connection'); return null; },
      async getState() { entityLogger.warn('this.ha.getState() unavailable — no WebSocket connection'); return null; },
      async getEntities() { entityLogger.warn('this.ha.getEntities() unavailable — no WebSocket connection'); return []; },
      async fireEvent() { entityLogger.warn('this.ha.fireEvent() unavailable — no WebSocket connection'); },
      friendlyName(id: string) { return id; },
    };

    return {
      ha: haApi ? haApi.asStateless() : stubStatelessApi,
      log: entityLogger,
    };
  }

  /**
   * Teardown entities from specific source files, leaving others untouched.
   */
  async teardownBySourceFiles(sourceFiles: Set<string>): Promise<void> {
    // Teardown devices from these files first
    for (const [deviceId, deviceInstance] of this.deviceInstances) {
      if (!sourceFiles.has(deviceInstance.device.sourceFile)) continue;
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
      this.deviceInstances.delete(deviceId);
    }

    // Teardown automations from these files
    for (const [id, instance] of this.automationInstances) {
      if (!sourceFiles.has(instance.automation.sourceFile)) continue;
      await this.teardownAutomation(id);
    }

    // Teardown tasks from these files
    for (const [id, instance] of this.taskInstances) {
      if (!sourceFiles.has(instance.task.sourceFile)) continue;
      await this.teardownTask(id);
    }

    // Teardown modes from these files
    for (const [id, instance] of this.modeInstances) {
      if (!sourceFiles.has(instance.mode.sourceFile)) continue;
      await this.teardownMode(id);
    }

    // Teardown entities from these files
    for (const [id, instance] of this.instances) {
      if (!sourceFiles.has(instance.entity.sourceFile)) continue;
      await this.teardown(id);
    }
  }

  /** Get set of source files that have running entities/automations/tasks/modes. */
  getActiveSourceFiles(): Set<string> {
    const files = new Set<string>();
    for (const instance of this.instances.values()) {
      files.add(instance.entity.sourceFile);
    }
    for (const instance of this.automationInstances.values()) {
      files.add(instance.automation.sourceFile);
    }
    for (const instance of this.taskInstances.values()) {
      files.add(instance.task.sourceFile);
    }
    for (const instance of this.modeInstances.values()) {
      files.add(instance.mode.sourceFile);
    }
    return files;
  }

  /** Get entity definitions for a given source file (for diffing). */
  getEntitiesBySourceFile(sourceFile: string): ResolvedEntity[] {
    const result: ResolvedEntity[] = [];
    for (const instance of this.instances.values()) {
      if (instance.entity.sourceFile === sourceFile) {
        result.push(instance.entity);
      }
    }
    return result;
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

    // Teardown automations
    const autoIds = [...this.automationInstances.keys()];
    for (const id of autoIds) {
      await this.teardownAutomation(id);
    }

    // Teardown tasks
    const taskIds = [...this.taskInstances.keys()];
    for (const id of taskIds) {
      await this.teardownTask(id);
    }

    // Teardown modes
    const modeIds = [...this.modeInstances.keys()];
    for (const id of modeIds) {
      await this.teardownMode(id);
    }

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
    if ('destroy' in instance.entity.definition && instance.entity.definition.destroy && instance.initialized && !instance.ownedByDevice) {
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

  private async teardownAutomation(automationId: string): Promise<void> {
    const instance = this.automationInstances.get(automationId);
    if (!instance) return;

    if (instance.automation.definition.destroy && instance.initialized && instance.context) {
      try {
        await instance.automation.definition.destroy.call(instance.context);
      } catch (err) {
        this.logger.error(`Automation destroy() failed for ${automationId}`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    this.disposeHandles(instance.handles);

    // Deregister entity if automation had entity: true
    if (instance.automation.definition.entity) {
      try {
        await this.transport.deregister(automationId);
      } catch (err) {
        this.logger.error(`Deregister failed for automation entity ${automationId}`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    this.automationInstances.delete(automationId);
  }

  private async teardownTask(taskId: string): Promise<void> {
    const instance = this.taskInstances.get(taskId);
    if (!instance) return;

    this.disposeHandles(instance.handles);

    // Deregister button entity
    try {
      await this.transport.deregister(taskId);
    } catch (err) {
      this.logger.error(`Deregister failed for task ${taskId}`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    this.taskInstances.delete(taskId);
  }

  private async teardownMode(modeId: string): Promise<void> {
    const instance = this.modeInstances.get(modeId);
    if (!instance) return;

    // Run exit hook for current state before teardown
    const def = instance.mode.definition;
    const currentTransition = def.transitions?.[instance.currentState as typeof def.states[number]];
    if (currentTransition?.exit && instance.initialized) {
      try {
        const ctx = this.createModeContext(instance);
        await currentTransition.exit.call(ctx);
      } catch (err) {
        this.logger.error(`Mode ${modeId}: exit(${instance.currentState}) failed during teardown`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    this.disposeHandles(instance.handles);

    // Deregister select entity
    try {
      await this.transport.deregister(modeId);
    } catch (err) {
      this.logger.error(`Deregister failed for mode ${modeId}`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    this.modeInstances.delete(modeId);
  }

  private disposeHandles(handles: TrackedHandles): void {
    for (const t of handles.timeouts) clearTimeout(t);
    for (const i of handles.intervals) clearInterval(i);
    for (const ref of handles.pollRefs) {
      if (ref.timer) clearTimeout(ref.timer);
    }
    for (const unsub of handles.mqttSubscriptions) unsub();
    for (const unsub of handles.eventSubscriptions) unsub();
    handles.timeouts = [];
    handles.intervals = [];
    handles.pollRefs = [];
    handles.mqttSubscriptions = [];
    handles.eventSubscriptions = [];
  }

  private createContext(instance: EntityInstance): EntityContext {
    const { entity, handles } = instance;
    const transport = this.transport;
    const logger = this.logger;
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

    const onStateChange = this.onStateChange;
    const haApi = this.haApi;

    const stubStatelessApi: StatelessHAApi = {
      async callService() { entityLogger.warn('this.ha.callService() unavailable — no WebSocket connection'); return null; },
      async getState() { entityLogger.warn('this.ha.getState() unavailable — no WebSocket connection'); return null; },
      async getEntities() { entityLogger.warn('this.ha.getEntities() unavailable — no WebSocket connection'); return []; },
      async fireEvent() { entityLogger.warn('this.ha.fireEvent() unavailable — no WebSocket connection'); },
      friendlyName(id: string) { return id; },
    };

    const stubEvents: EventsContext = {
      on() { entityLogger.warn('this.events.on() unavailable — no WebSocket connection'); return createEventStream(() => () => {}); },
      reactions() { entityLogger.warn('this.events.reactions() unavailable — no WebSocket connection'); return () => {}; },
      combine() { entityLogger.warn('this.events.combine() unavailable — no WebSocket connection'); return () => {}; },
      withState() { entityLogger.warn('this.events.withState() unavailable — no WebSocket connection'); return createEventStream(() => () => {}); },
      watchdog() { entityLogger.warn('this.events.watchdog() unavailable — no WebSocket connection'); return () => {}; },
      invariant() { entityLogger.warn('this.events.invariant() unavailable — no WebSocket connection'); return () => {}; },
      sequence() { entityLogger.warn('this.events.sequence() unavailable — no WebSocket connection'); return () => {}; },
    };

    const context: EntityContext = {
      update(value: unknown, attributes?: Record<string, unknown>) {
        instance.currentState = value;
        transport.publishState(entityId, value, attributes).then(() => {
          transport.clearEntityFailure?.(entityId);
          onStateChange?.(entityId, value);
        }).catch((err) => {
          transport.recordEntityFailure?.(entityId);
          entityLogger.error('Failed to publish state', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      },

      attr(attributes: Record<string, unknown>) {
        transport.publishState(entityId, instance.currentState, attributes).then(() => {
          transport.clearEntityFailure?.(entityId);
        }).catch((err) => {
          transport.recordEntityFailure?.(entityId);
          entityLogger.error('Failed to publish attributes', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      },

      ha: haApi ? haApi.asStateless() : stubStatelessApi,
      events: haApi ? haApi.createScopedEvents(handles) : stubEvents,

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

  private createAutomationContext(instance: AutomationInstance): AutomationContext {
    const { automation, handles } = instance;
    const rawMqtt = this.rawMqtt;
    const haApi = this.haApi;

    const scopedLogger = this.logger.forEntity
      ? this.logger.forEntity(automation.definition.id, automation.sourceFile)
      : this.logger;

    const entityLogger: EntityLogger = {
      debug: (msg, data) => scopedLogger.debug(msg, data),
      info: (msg, data) => scopedLogger.info(msg, data),
      warn: (msg, data) => scopedLogger.warn(msg, data),
      error: (msg, data) => scopedLogger.error(msg, data),
    };

    const stubStatelessApi: StatelessHAApi = {
      async callService() { entityLogger.warn('this.ha.callService() unavailable — no WebSocket connection'); return null; },
      async getState() { entityLogger.warn('this.ha.getState() unavailable — no WebSocket connection'); return null; },
      async getEntities() { entityLogger.warn('this.ha.getEntities() unavailable — no WebSocket connection'); return []; },
      async fireEvent() { entityLogger.warn('this.ha.fireEvent() unavailable — no WebSocket connection'); },
      friendlyName(id: string) { return id; },
    };

    const stubEvents: EventsContext = {
      on() { entityLogger.warn('this.events.on() unavailable — no WebSocket connection'); return createEventStream(() => () => {}); },
      reactions() { entityLogger.warn('this.events.reactions() unavailable — no WebSocket connection'); return () => {}; },
      combine() { entityLogger.warn('this.events.combine() unavailable — no WebSocket connection'); return () => {}; },
      withState() { entityLogger.warn('this.events.withState() unavailable — no WebSocket connection'); return createEventStream(() => () => {}); },
      watchdog() { entityLogger.warn('this.events.watchdog() unavailable — no WebSocket connection'); return () => {}; },
      invariant() { entityLogger.warn('this.events.invariant() unavailable — no WebSocket connection'); return () => {}; },
      sequence() { entityLogger.warn('this.events.sequence() unavailable — no WebSocket connection'); return () => {}; },
    };

    return {
      ha: haApi ? haApi.asStateless() : stubStatelessApi,
      events: haApi ? haApi.createScopedEvents(handles) : stubEvents,
      log: entityLogger,

      setTimeout(fn: () => void, ms: number) {
        const t = globalThis.setTimeout(fn, ms);
        handles.timeouts.push(t);
      },

      setInterval(fn: () => void, ms: number) {
        const i = globalThis.setInterval(fn, ms);
        handles.intervals.push(i);
      },

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
  }

  private createTaskContext(instance: TaskInstance): TaskContext {
    const { task, handles } = instance;
    const rawMqtt = this.rawMqtt;
    const haApi = this.haApi;

    const scopedLogger = this.logger.forEntity
      ? this.logger.forEntity(task.definition.id, task.sourceFile)
      : this.logger;

    const entityLogger: EntityLogger = {
      debug: (msg, data) => scopedLogger.debug(msg, data),
      info: (msg, data) => scopedLogger.info(msg, data),
      warn: (msg, data) => scopedLogger.warn(msg, data),
      error: (msg, data) => scopedLogger.error(msg, data),
    };

    const stubStatelessApi: StatelessHAApi = {
      async callService() { entityLogger.warn('this.ha.callService() unavailable — no WebSocket connection'); return null; },
      async getState() { entityLogger.warn('this.ha.getState() unavailable — no WebSocket connection'); return null; },
      async getEntities() { entityLogger.warn('this.ha.getEntities() unavailable — no WebSocket connection'); return []; },
      async fireEvent() { entityLogger.warn('this.ha.fireEvent() unavailable — no WebSocket connection'); },
      friendlyName(id: string) { return id; },
    };

    return {
      ha: haApi ? haApi.asStateless() : stubStatelessApi,
      log: entityLogger,

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
  }

  getEntityState(entityId: string): unknown {
    return this.instances.get(entityId)?.currentState;
  }

  getEntityIds(): string[] {
    return [
      ...this.instances.keys(),
      ...this.automationInstances.keys(),
      ...this.taskInstances.keys(),
    ];
  }

  getEntityInfo(entityId: string): { type: string; name: string; sourceFile: string } | undefined {
    const instance = this.instances.get(entityId);
    if (instance) {
      return {
        type: instance.entity.definition.type,
        name: instance.entity.definition.name || entityId,
        sourceFile: instance.entity.sourceFile,
      };
    }

    const autoInstance = this.automationInstances.get(entityId);
    if (autoInstance) {
      return {
        type: 'automation',
        name: entityId,
        sourceFile: autoInstance.automation.sourceFile,
      };
    }

    const taskInstance = this.taskInstances.get(entityId);
    if (taskInstance) {
      return {
        type: 'task',
        name: taskInstance.task.definition.name,
        sourceFile: taskInstance.task.sourceFile,
      };
    }

    return undefined;
  }

  isInitialized(entityId: string): boolean {
    return this.instances.get(entityId)?.initialized ?? false;
  }
}

import type {
  EntityLogger,
  EventsContext,
  StatelessHAApi,
} from '@ha-forge/sdk';
import { createEventStream } from '@ha-forge/sdk';
import type { LifecycleLogger, RawMqttAccess } from './lifecycle.js';
import { getSecret } from './loader.js';

interface TrackedHandles {
  mqttSubscriptions: Array<() => void>;
}

export function createScopedLogger(logger: LifecycleLogger, entityId: string, sourceFile?: string): EntityLogger {
  const scoped = logger.forEntity
    ? logger.forEntity(entityId, sourceFile)
    : logger;

  return {
    debug: (msg, data) => scoped.debug(msg, data),
    info: (msg, data) => scoped.info(msg, data),
    warn: (msg, data) => scoped.warn(msg, data),
    error: (msg, data) => scoped.error(msg, data),
  };
}

export function createStubHistoryApi(logger: EntityLogger): import('@ha-forge/sdk').HistoryApi {
  return {
    async recentlyIn() { logger.warn('this.ha.history.recentlyIn() unavailable — no connection'); return false; },
    async average() { logger.warn('this.ha.history.average() unavailable — no connection'); return null; },
    async countTransitions() { logger.warn('this.ha.history.countTransitions() unavailable — no connection'); return 0; },
    async duration() { logger.warn('this.ha.history.duration() unavailable — no connection'); return 0; },
  };
}

export function createStubHaApi(logger: EntityLogger): StatelessHAApi {
  return {
    async callService() { logger.warn('this.ha.callService() unavailable — no WebSocket connection'); return null; },
    async getState() { logger.warn('this.ha.getState() unavailable — no WebSocket connection'); return null; },
    async getEntities() { logger.warn('this.ha.getEntities() unavailable — no WebSocket connection'); return []; },
    async fireEvent() { logger.warn('this.ha.fireEvent() unavailable — no WebSocket connection'); },
    friendlyName(id: string) { return id; },
    secret: getSecret,
    history: createStubHistoryApi(logger),
  };
}

export function createStubEvents(logger: EntityLogger): EventsContext {
  return {
    stream() { logger.warn('this.events.stream() unavailable — no WebSocket connection'); return createEventStream(() => () => {}); },
    reactions() { logger.warn('this.events.reactions() unavailable — no WebSocket connection'); return () => {}; },
    combine() { logger.warn('this.events.combine() unavailable — no WebSocket connection'); return () => {}; },
    withState() { logger.warn('this.events.withState() unavailable — no WebSocket connection'); return { unsubscribe() {} }; },
    watchdog() { logger.warn('this.events.watchdog() unavailable — no WebSocket connection'); return () => {}; },
    invariant() { logger.warn('this.events.invariant() unavailable — no WebSocket connection'); return () => {}; },
    sequence() { logger.warn('this.events.sequence() unavailable — no WebSocket connection'); return () => {}; },
  };
}

export function createMqttContext(
  rawMqtt: RawMqttAccess | null,
  logger: EntityLogger,
  handles: TrackedHandles,
): { publish(topic: string, payload: string, opts?: Record<string, unknown>): void; subscribe(topic: string, handler: (payload: string) => void): void } {
  return {
    publish(topic, payload, opts) {
      if (!rawMqtt) { logger.warn('mqtt.publish() unavailable — no MQTT connection'); return; }
      rawMqtt.publishRaw(topic, payload, opts);
    },
    subscribe(topic, handler) {
      if (!rawMqtt) { logger.warn('mqtt.subscribe() unavailable — no MQTT connection'); return; }
      const unsub = rawMqtt.subscribeRaw(topic, handler);
      handles.mqttSubscriptions.push(unsub);
    },
  };
}

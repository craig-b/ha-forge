import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EntityLifecycleManager } from '../lifecycle.js';
import type { Transport } from '../transport.js';
import type { EntityContext, SensorDefinition } from '@ha-forge/sdk';
import type { ResolvedEntity } from '@ha-forge/sdk/internal';
import type { HAClient } from '../ha-api.js';
import { HAApiImpl } from '../ha-api.js';
import type { HAWebSocketClient, HAEvent } from '../ws-client.js';

function createMockTransport(): Transport & {
  register: ReturnType<typeof vi.fn>;
  publishState: ReturnType<typeof vi.fn>;
  onCommand: ReturnType<typeof vi.fn>;
  deregister: ReturnType<typeof vi.fn>;
} {
  return {
    supports: vi.fn(() => true),
    register: vi.fn(async () => {}),
    publishState: vi.fn(async () => {}),
    onCommand: vi.fn(),
    deregister: vi.fn(async () => {}),
  };
}

function createMockLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createMockHAClient(): HAClient & {
  on: ReturnType<typeof vi.fn>;
  callService: ReturnType<typeof vi.fn>;
  getState: ReturnType<typeof vi.fn>;
  getEntities: ReturnType<typeof vi.fn>;
  fireEvent: ReturnType<typeof vi.fn>;
} {
  return {
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    on: vi.fn(() => () => {}),
    callService: vi.fn(async () => null),
    getState: vi.fn(async () => null),
    getEntities: vi.fn(async () => []),
    fireEvent: vi.fn(async () => {}),
    reactions: vi.fn(() => () => {}),
    friendlyName: vi.fn((id: string) => id),
  };
}

function createMockWSClient(): HAWebSocketClient & {
  sendCommand: ReturnType<typeof vi.fn>;
  subscribeEvents: ReturnType<typeof vi.fn>;
  unsubscribeEvents: ReturnType<typeof vi.fn>;
} {
  return {
    sendCommand: vi.fn(async () => null),
    subscribeEvents: vi.fn(async () => 42),
    unsubscribeEvents: vi.fn(async () => {}),
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    isConnected: vi.fn(() => true),
    getHAVersion: vi.fn(() => '2024.1.0'),
  } as unknown as HAWebSocketClient & {
    sendCommand: ReturnType<typeof vi.fn>;
    subscribeEvents: ReturnType<typeof vi.fn>;
    unsubscribeEvents: ReturnType<typeof vi.fn>;
  };
}

function makeStateChangedEvent(
  entityId: string,
  oldState: string,
  newState: string,
): HAEvent {
  return {
    event_type: 'state_changed',
    data: {
      entity_id: entityId,
      old_state: { entity_id: entityId, state: oldState, attributes: {}, last_changed: '', last_updated: '', context: { id: '1', parent_id: null, user_id: null } },
      new_state: { entity_id: entityId, state: newState, attributes: {}, last_changed: '', last_updated: '', context: { id: '2', parent_id: null, user_id: null } },
    } as unknown as Record<string, unknown>,
    time_fired: '2024-01-15T10:00:01.000Z',
    origin: 'LOCAL',
    context: { id: '2', parent_id: null, user_id: null },
  };
}

function makeSensorEntity(id: string, overrides: Partial<SensorDefinition> = {}): ResolvedEntity {
  const definition: SensorDefinition = {
    id,
    name: `Sensor ${id}`,
    type: 'sensor',
    ...overrides,
  };
  return { definition, sourceFile: `/entities/${id}.ts`, deviceId: 'test-device' };
}

describe('EntityLifecycleManager — ha global integration', () => {
  let transport: ReturnType<typeof createMockTransport>;
  let logger: ReturnType<typeof createMockLogger>;
  let haClient: ReturnType<typeof createMockHAClient>;
  let manager: EntityLifecycleManager;
  let savedHa: unknown;

  beforeEach(() => {
    transport = createMockTransport();
    logger = createMockLogger();
    haClient = createMockHAClient();
    manager = new EntityLifecycleManager(transport, logger);
    // Install mock as global ha
    savedHa = (globalThis as Record<string, unknown>).ha;
    (globalThis as Record<string, unknown>).ha = haClient;
  });

  afterEach(() => {
    vi.useRealTimers();
    // Restore global ha
    (globalThis as Record<string, unknown>).ha = savedHa;
  });

  it('entity init() can use global ha.on()', async () => {
    const entity = makeSensorEntity('temp', {
      init() {
        // Use global ha instead of this.ha
        (globalThis as unknown as Record<string, unknown> & { ha: HAClient }).ha.on('sensor.outdoor_temp', (e) => {
          this.update(e.new_state);
        });
        return '22';
      },
    });

    await manager.deploy([entity]);

    expect(haClient.on).toHaveBeenCalledWith('sensor.outdoor_temp', expect.any(Function));
    expect(manager.isInitialized('temp')).toBe(true);
  });

  it('entity init() can use global ha.callService()', async () => {
    const entity = makeSensorEntity('light_ctrl', {
      init() {
        (globalThis as unknown as Record<string, unknown> & { ha: HAClient }).ha.callService('light.living_room', 'turn_on', { brightness: 200 });
        return '1';
      },
    });

    await manager.deploy([entity]);

    expect(haClient.callService).toHaveBeenCalledWith(
      'light.living_room', 'turn_on', { brightness: 200 },
    );
  });

  it('entity init() can use global ha.getState()', async () => {
    haClient.getState.mockResolvedValue({
      state: 'on',
      attributes: { brightness: 128 },
      last_changed: '2024-01-01T00:00:00Z',
      last_updated: '2024-01-01T00:00:00Z',
    });

    const entity = makeSensorEntity('mirror', {
      async init() {
        const state = await (globalThis as unknown as Record<string, unknown> & { ha: HAClient }).ha.getState('light.living_room');
        return state?.state ?? 'unknown';
      },
    });

    await manager.deploy([entity]);

    expect(haClient.getState).toHaveBeenCalledWith('light.living_room');
    expect(manager.getEntityState('mirror')).toBe('on');
  });

  it('entity init() can use global ha.getEntities()', async () => {
    haClient.getEntities.mockResolvedValue(['light.a', 'light.b']);

    const entity = makeSensorEntity('counter', {
      async init() {
        const lights = await (globalThis as unknown as Record<string, unknown> & { ha: HAClient }).ha.getEntities('light');
        return String(lights.length);
      },
    });

    await manager.deploy([entity]);

    expect(haClient.getEntities).toHaveBeenCalledWith('light');
    expect(manager.getEntityState('counter')).toBe('2');
  });

  it('entity init() can use global ha.fireEvent()', async () => {
    const entity = makeSensorEntity('eventer', {
      init() {
        (globalThis as unknown as Record<string, unknown> & { ha: HAClient }).ha.fireEvent('custom_event', { source: 'test' });
        return '0';
      },
    });

    await manager.deploy([entity]);

    expect(haClient.fireEvent).toHaveBeenCalledWith('custom_event', { source: 'test' });
  });
});

describe('EntityLifecycleManager — this.ha and this.events', () => {
  let transport: ReturnType<typeof createMockTransport>;
  let logger: ReturnType<typeof createMockLogger>;
  let wsClient: ReturnType<typeof createMockWSClient>;
  let haApi: HAApiImpl;
  let manager: EntityLifecycleManager;

  beforeEach(async () => {
    transport = createMockTransport();
    logger = createMockLogger();
    wsClient = createMockWSClient();
    haApi = new HAApiImpl(wsClient, { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });
    await haApi.init();
    manager = new EntityLifecycleManager(transport, logger, null, undefined, haApi);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await haApi.destroy();
  });

  it('this.ha.callService() works from init()', async () => {
    const entity = makeSensorEntity('svc-test', {
      async init() {
        await this.ha.callService('light.kitchen', 'turn_on', { brightness: 200 });
        return '1';
      },
    });

    await manager.deploy([entity]);

    expect(wsClient.sendCommand).toHaveBeenCalledWith('call_service', expect.objectContaining({
      domain: 'light',
      service: 'turn_on',
    }));
  });

  it('this.ha.getState() works from init()', async () => {
    wsClient.sendCommand.mockResolvedValueOnce([
      { entity_id: 'sensor.temp', state: '22', attributes: {}, last_changed: '', last_updated: '' },
    ]);

    const entity = makeSensorEntity('state-test', {
      async init() {
        const state = await this.ha.getState('sensor.temp');
        return state?.state ?? 'unknown';
      },
    });

    await manager.deploy([entity]);

    expect(manager.getEntityState('state-test')).toBe('22');
  });

  it('this.events.stream().subscribe() works from init()', async () => {
    const cb = vi.fn();
    const entity = makeSensorEntity('events-test', {
      init() {
        this.events.stream('light.kitchen').subscribe(cb);
        return '0';
      },
    });

    await manager.deploy([entity]);

    haApi.handleEvent(42, makeStateChangedEvent('light.kitchen', 'off', 'on'));
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('this.events.stream().subscribe() subscriptions are cleaned up on teardown', async () => {
    const cb = vi.fn();
    const entity = makeSensorEntity('cleanup-test', {
      init() {
        this.events.stream('light.kitchen').subscribe(cb);
        return '0';
      },
    });

    await manager.deploy([entity]);
    await manager.teardownAll();

    haApi.handleEvent(42, makeStateChangedEvent('light.kitchen', 'off', 'on'));
    expect(cb).not.toHaveBeenCalled();
  });

  it('this.events.reactions() subscriptions are cleaned up on teardown', async () => {
    vi.useFakeTimers();
    const action = vi.fn();
    const entity = makeSensorEntity('reaction-cleanup', {
      init() {
        this.events.reactions({
          'binary_sensor.door': { to: 'on', after: 5000, do: action },
        });
        return '0';
      },
    });

    await manager.deploy([entity]);

    // Trigger reaction
    haApi.handleEvent(42, makeStateChangedEvent('binary_sensor.door', 'off', 'on'));

    // Teardown before timer fires
    await manager.teardownAll();

    vi.advanceTimersByTime(6000);
    expect(action).not.toHaveBeenCalled();
  });

  it('provides stub ha/events when no haApi is passed', async () => {
    const noApiManager = new EntityLifecycleManager(transport, logger);
    const entity = makeSensorEntity('no-api', {
      init() {
        // These should not throw, just log warnings
        this.ha.callService('light.test', 'turn_on');
        this.events.stream('light.test').subscribe(() => {});
        return '0';
      },
    });

    await noApiManager.deploy([entity]);
    expect(noApiManager.isInitialized('no-api')).toBe(true);
  });
});

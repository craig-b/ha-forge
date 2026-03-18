import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EntityLifecycleManager } from '../lifecycle.js';
import type { Transport } from '../transport.js';
import type { HAClient, ResolvedEntity, SensorDefinition } from '@ha-ts-entities/sdk';

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
    on: vi.fn(() => () => {}),
    callService: vi.fn(async () => {}),
    getState: vi.fn(async () => null),
    getEntities: vi.fn(async () => []),
    fireEvent: vi.fn(async () => {}),
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

describe('EntityLifecycleManager — ha integration', () => {
  let transport: ReturnType<typeof createMockTransport>;
  let logger: ReturnType<typeof createMockLogger>;
  let haClient: ReturnType<typeof createMockHAClient>;
  let manager: EntityLifecycleManager;

  beforeEach(() => {
    transport = createMockTransport();
    logger = createMockLogger();
    haClient = createMockHAClient();
    manager = new EntityLifecycleManager(transport, logger, haClient);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('provides ha.on() in entity context during init()', async () => {
    const entity = makeSensorEntity('temp', {
      init() {
        // Subscribe to external HA entity changes
        this.ha.on('sensor.outdoor_temp', (e) => {
          this.update(e.new_state);
        });
        return '22';
      },
    });

    await manager.deploy([entity]);

    expect(haClient.on).toHaveBeenCalledWith('sensor.outdoor_temp', expect.any(Function));
    expect(manager.isInitialized('temp')).toBe(true);
  });

  it('provides ha.callService() in entity context', async () => {
    const entity = makeSensorEntity('light_ctrl', {
      init() {
        this.ha.callService('light.living_room', 'turn_on', { brightness: 200 });
        return '1';
      },
    });

    await manager.deploy([entity]);

    expect(haClient.callService).toHaveBeenCalledWith(
      'light.living_room', 'turn_on', { brightness: 200 },
    );
  });

  it('provides ha.getState() in entity context', async () => {
    haClient.getState.mockResolvedValue({
      state: 'on',
      attributes: { brightness: 128 },
      last_changed: '2024-01-01T00:00:00Z',
      last_updated: '2024-01-01T00:00:00Z',
    });

    const entity = makeSensorEntity('mirror', {
      async init() {
        const state = await this.ha.getState('light.living_room');
        return state?.state ?? 'unknown';
      },
    });

    await manager.deploy([entity]);

    expect(haClient.getState).toHaveBeenCalledWith('light.living_room');
    expect(manager.getEntityState('mirror')).toBe('on');
  });

  it('provides ha.getEntities() in entity context', async () => {
    haClient.getEntities.mockResolvedValue(['light.a', 'light.b']);

    const entity = makeSensorEntity('counter', {
      async init() {
        const lights = await this.ha.getEntities('light');
        return String(lights.length);
      },
    });

    await manager.deploy([entity]);

    expect(haClient.getEntities).toHaveBeenCalledWith('light');
    expect(manager.getEntityState('counter')).toBe('2');
  });

  it('provides ha.fireEvent() in entity context', async () => {
    const entity = makeSensorEntity('eventer', {
      init() {
        this.ha.fireEvent('custom_event', { source: 'test' });
        return '0';
      },
    });

    await manager.deploy([entity]);

    expect(haClient.fireEvent).toHaveBeenCalledWith('custom_event', { source: 'test' });
  });

  it('provides ha stub warnings when no HA client is provided', async () => {
    const managerNoHA = new EntityLifecycleManager(transport, logger);

    const entity = makeSensorEntity('no_ha', {
      init() {
        this.ha.on('sensor.test', () => {});
        return '0';
      },
    });

    await managerNoHA.deploy([entity]);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('ha.on() unavailable'),
      undefined,
    );
  });
});

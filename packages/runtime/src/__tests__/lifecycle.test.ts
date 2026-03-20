import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EntityLifecycleManager } from '../lifecycle.js';
import type { Transport } from '../transport.js';
import type { ResolvedDevice } from '../loader.js';
import type { DeviceDefinition, ResolvedEntity, SensorDefinition, SwitchDefinition } from '@ha-ts-entities/sdk';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function makeSensorEntity(
  id: string,
  overrides: Partial<SensorDefinition> = {},
): ResolvedEntity {
  const definition: SensorDefinition = {
    id,
    name: `Sensor ${id}`,
    type: 'sensor',
    ...overrides,
  };
  return { definition, sourceFile: `/entities/${id}.ts`, deviceId: 'test-device' };
}

function makeSwitchEntity(
  id: string,
  overrides: Partial<SwitchDefinition> = {},
): ResolvedEntity {
  const definition: SwitchDefinition = {
    id,
    name: `Switch ${id}`,
    type: 'switch',
    onCommand: vi.fn(),
    ...overrides,
  };
  return { definition, sourceFile: `/entities/${id}.ts`, deviceId: 'test-device' };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EntityLifecycleManager', () => {
  let transport: ReturnType<typeof createMockTransport>;
  let logger: ReturnType<typeof createMockLogger>;
  let manager: EntityLifecycleManager;

  beforeEach(() => {
    transport = createMockTransport();
    logger = createMockLogger();
    manager = new EntityLifecycleManager(transport, logger);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // 1. deploy() registers all entities with the transport
  it('registers each entity with the transport on deploy', async () => {
    const entities = [makeSensorEntity('temp'), makeSensorEntity('humidity')];

    await manager.deploy(entities);

    expect(transport.register).toHaveBeenCalledTimes(2);
    expect(transport.register).toHaveBeenCalledWith(entities[0]);
    expect(transport.register).toHaveBeenCalledWith(entities[1]);
  });

  // 2. init() return value is published as initial state
  it('publishes the return value of init() as initial state', async () => {
    const entity = makeSensorEntity('temp', {
      init() {
        return '42';
      },
    });

    await manager.deploy([entity]);

    expect(transport.publishState).toHaveBeenCalledWith('temp', '42');
    expect(manager.getEntityState('temp')).toBe('42');
  });

  // 3. init() returning undefined does not publish state
  it('does not publish state when init() returns undefined', async () => {
    const entity = makeSensorEntity('temp', {
      async init() {
        return undefined as unknown as string;
      },
    });

    await manager.deploy([entity]);

    expect(transport.publishState).not.toHaveBeenCalled();
  });

  // 4. entity with no init() is still marked initialized
  it('marks an entity as initialized even when it has no init()', async () => {
    const entity = makeSensorEntity('no-init');

    await manager.deploy([entity]);

    expect(manager.isInitialized('no-init')).toBe(true);
  });

  // 5. a failing init() does not block subsequent entities
  it('continues initializing remaining entities when one init() throws', async () => {
    const failing = makeSensorEntity('bad', {
      init() {
        throw new Error('boom');
      },
    });
    const good = makeSensorEntity('good', {
      init() {
        return 'ok';
      },
    });

    await manager.deploy([failing, good]);

    expect(manager.isInitialized('bad')).toBe(false);
    expect(manager.isInitialized('good')).toBe(true);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to initialize entity bad'),
      expect.objectContaining({ error: 'boom' }),
    );
  });

  // 6. teardownAll() calls destroy() on all initialized entities
  it('calls destroy() on all initialized entities during teardownAll', async () => {
    const destroyA = vi.fn();
    const destroyB = vi.fn();

    const a = makeSensorEntity('a', { init() { return '1'; }, destroy: destroyA });
    const b = makeSensorEntity('b', { init() { return '2'; }, destroy: destroyB });

    await manager.deploy([a, b]);
    await manager.teardownAll();

    expect(destroyA).toHaveBeenCalledTimes(1);
    expect(destroyB).toHaveBeenCalledTimes(1);
    expect(manager.getEntityIds()).toHaveLength(0);
  });

  // 7. deploy() tears down previous entities before registering new ones
  it('tears down previous entities before deploying new ones', async () => {
    const destroyFirst = vi.fn();
    const first = makeSensorEntity('first', { init() { return '1'; }, destroy: destroyFirst });

    await manager.deploy([first]);
    expect(manager.getEntityIds()).toContain('first');

    const second = makeSensorEntity('second', { init() { return '2'; } });
    await manager.deploy([second]);

    expect(destroyFirst).toHaveBeenCalledTimes(1);
    expect(manager.getEntityIds()).not.toContain('first');
    expect(manager.getEntityIds()).toContain('second');
  });

  // 8. update() from entity context publishes state via transport
  it('publishes state when context.update() is called from init()', async () => {
    const entity = makeSensorEntity('updater', {
      init() {
        // Invoke update() during init to simulate an async push
        this.update('pushed');
        return undefined as unknown as string;
      },
    });

    await manager.deploy([entity]);

    // update() schedules a publish but does not await; flush microtasks
    await Promise.resolve();

    expect(transport.publishState).toHaveBeenCalledWith('updater', 'pushed', undefined);
    expect(manager.getEntityState('updater')).toBe('pushed');
  });

  // 9. poll() registers a repeating interval that calls publishState
  it('sets up a repeating interval via context.poll()', async () => {
    let callCount = 0;
    const entity = makeSensorEntity('poller', {
      init() {
        this.poll(() => {
          callCount += 1;
          return `tick-${callCount}`;
        }, { interval: 1000 });
        return undefined as unknown as string;
      },
    });

    await manager.deploy([entity]);

    // poll() fires immediately on deploy, then repeats on interval
    // Flush the immediate call
    await vi.advanceTimersByTimeAsync(0);

    expect(callCount).toBe(1);

    // Advance timers by 3 seconds to trigger 3 more interval calls
    await vi.advanceTimersByTimeAsync(3000);

    expect(callCount).toBe(4);
    expect(transport.publishState).toHaveBeenCalledTimes(4);
    expect(transport.publishState).toHaveBeenLastCalledWith('poller', 'tick-4', undefined);
  });

  // 10. teardown clears all tracked timer handles
  it('clears all timer handles when an entity is torn down', async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

    const entity = makeSensorEntity('timer-entity', {
      init() {
        this.setTimeout(() => {}, 5000);
        this.setInterval(() => {}, 2000);
        this.poll(() => 'x', { interval: 3000 });
        return undefined as unknown as string;
      },
    });

    await manager.deploy([entity]);
    await manager.teardownAll();

    // Two clearTimeout calls: one for setTimeout handle + one for poll ref
    expect(clearTimeoutSpy).toHaveBeenCalledTimes(2);
    // One clearInterval call for setInterval
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
  });

  // 11. onCommand is registered for switch entities
  it('registers a command handler for switch (bidirectional) entities', async () => {
    const onCommand = vi.fn();
    const entity = makeSwitchEntity('my-switch', { onCommand });

    await manager.deploy([entity]);

    expect(transport.onCommand).toHaveBeenCalledWith('my-switch', expect.any(Function));
  });

  // 12. command handler dispatches to entity onCommand with EntityContext as `this`
  it('dispatches received commands to the entity onCommand handler', async () => {
    const onCommand = vi.fn();
    const entity = makeSwitchEntity('sw', { onCommand });

    await manager.deploy([entity]);

    // Grab the handler the manager registered on the transport
    const [, registeredHandler] = transport.onCommand.mock.calls[0] as [string, (cmd: unknown) => void];
    registeredHandler('ON');

    expect(onCommand).toHaveBeenCalledTimes(1);
    expect(onCommand).toHaveBeenCalledWith('ON');
  });

  // 13. onCommand handler errors are caught and logged, not thrown
  it('catches errors thrown by onCommand and logs them without crashing', async () => {
    const onCommand = vi.fn(() => {
      throw new Error('command error');
    });
    const entity = makeSwitchEntity('sw-err', { onCommand });

    await manager.deploy([entity]);

    const [, registeredHandler] = transport.onCommand.mock.calls[0] as [string, (cmd: unknown) => void];
    expect(() => registeredHandler('OFF')).not.toThrow();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Command handler error for sw-err'),
      expect.objectContaining({ error: 'command error' }),
    );
  });

  // 14. getEntityIds returns all currently managed entity ids
  it('getEntityIds returns ids of all deployed entities', async () => {
    await manager.deploy([makeSensorEntity('x'), makeSensorEntity('y'), makeSensorEntity('z')]);
    expect(manager.getEntityIds()).toEqual(expect.arrayContaining(['x', 'y', 'z']));
    expect(manager.getEntityIds()).toHaveLength(3);
  });

  // -------------------------------------------------------------------------
  // Device lifecycle tests
  // -------------------------------------------------------------------------

  describe('device lifecycle', () => {
    function makeDeviceWithEntities(): {
      entities: ResolvedEntity[];
      devices: ResolvedDevice[];
      initFn: ReturnType<typeof vi.fn>;
      destroyFn: ReturnType<typeof vi.fn>;
    } {
      const initFn = vi.fn();
      const destroyFn = vi.fn();

      const tempDef: SensorDefinition = {
        id: 'ws_temp', name: 'Temperature', type: 'sensor',
        config: { device_class: 'temperature', unit_of_measurement: '°C' },
      };
      const humidityDef: SensorDefinition = {
        id: 'ws_humidity', name: 'Humidity', type: 'sensor',
        config: { device_class: 'humidity', unit_of_measurement: '%' },
      };

      const deviceDef: DeviceDefinition = {
        __kind: 'device',
        id: 'weather_station',
        name: 'Weather Station',
        entities: { temperature: tempDef, humidity: humidityDef },
        init: initFn,
        destroy: destroyFn,
      };

      const entities: ResolvedEntity[] = [
        { definition: tempDef, sourceFile: 'weather.ts', deviceId: 'weather_station' },
        { definition: humidityDef, sourceFile: 'weather.ts', deviceId: 'weather_station' },
      ];

      const devices: ResolvedDevice[] = [{
        definition: deviceDef,
        sourceFile: 'weather.ts',
        entityIds: ['ws_temp', 'ws_humidity'],
      }];

      return { entities, devices, initFn, destroyFn };
    }

    it('registers device entities and calls device init()', async () => {
      const { entities, devices, initFn } = makeDeviceWithEntities();

      await manager.deploy(entities, devices);

      expect(transport.register).toHaveBeenCalledTimes(2);
      expect(initFn).toHaveBeenCalledTimes(1);
      expect(manager.getEntityIds()).toEqual(expect.arrayContaining(['ws_temp', 'ws_humidity']));
    });

    it('does not call individual entity init() for device-owned entities', async () => {
      const entityInit = vi.fn(() => '42');
      const tempDef: SensorDefinition = {
        id: 'ws_temp', name: 'Temperature', type: 'sensor',
        init: entityInit,
      };

      const deviceDef: DeviceDefinition = {
        __kind: 'device', id: 'dev1', name: 'Dev', entities: { temperature: tempDef },
        init: vi.fn(),
      };

      const entities: ResolvedEntity[] = [
        { definition: tempDef, sourceFile: 'test.ts', deviceId: 'dev1' },
      ];
      const devices: ResolvedDevice[] = [{
        definition: deviceDef, sourceFile: 'test.ts', entityIds: ['ws_temp'],
      }];

      await manager.deploy(entities, devices);

      // The entity's own init should NOT be called
      expect(entityInit).not.toHaveBeenCalled();
    });

    it('provides entity handles with update() in device context', async () => {
      const { entities, devices, initFn } = makeDeviceWithEntities();

      initFn.mockImplementation(function(this: { entities: Record<string, { update: (v: unknown) => void }> }) {
        this.entities.temperature.update('22.5');
        this.entities.humidity.update('65');
      });

      await manager.deploy(entities, devices);
      await Promise.resolve(); // flush microtasks

      expect(transport.publishState).toHaveBeenCalledWith('ws_temp', '22.5', undefined);
      expect(transport.publishState).toHaveBeenCalledWith('ws_humidity', '65', undefined);
      expect(manager.getEntityState('ws_temp')).toBe('22.5');
      expect(manager.getEntityState('ws_humidity')).toBe('65');
    });

    it('calls device destroy() on teardown', async () => {
      const { entities, devices, destroyFn } = makeDeviceWithEntities();

      await manager.deploy(entities, devices);
      await manager.teardownAll();

      expect(destroyFn).toHaveBeenCalledTimes(1);
    });

    it('provides poll() in device context that fires immediately', async () => {
      const { entities, devices, initFn } = makeDeviceWithEntities();
      let pollCount = 0;

      initFn.mockImplementation(function(this: { poll: (fn: () => void, opts: { interval: number }) => void; entities: Record<string, { update: (v: unknown) => void }> }) {
        this.poll(() => {
          pollCount++;
          this.entities.temperature.update(`tick-${pollCount}`);
        }, { interval: 1000 });
      });

      await manager.deploy(entities, devices);
      await vi.advanceTimersByTimeAsync(0); // flush immediate

      expect(pollCount).toBe(1);

      await vi.advanceTimersByTimeAsync(2000);
      expect(pollCount).toBe(3);
    });

    it('registers command handlers for bidirectional entities in devices', async () => {
      const switchDef: SwitchDefinition = {
        id: 'dev_switch', name: 'Switch', type: 'switch',
        onCommand: vi.fn(),
      };

      const deviceInit = vi.fn(function(this: { entities: Record<string, { onCommand: (h: (cmd: unknown) => void) => void }> }) {
        this.entities.sw.onCommand((cmd) => {
          // device handles the command
        });
      });

      const deviceDef: DeviceDefinition = {
        __kind: 'device', id: 'dev2', name: 'Dev',
        entities: { sw: switchDef },
        init: deviceInit,
      };

      const entities: ResolvedEntity[] = [
        { definition: switchDef, sourceFile: 'test.ts', deviceId: 'dev2' },
      ];
      const devices: ResolvedDevice[] = [{
        definition: deviceDef, sourceFile: 'test.ts', entityIds: ['dev_switch'],
      }];

      await manager.deploy(entities, devices);

      // Transport should have a command handler registered
      expect(transport.onCommand).toHaveBeenCalledWith('dev_switch', expect.any(Function));
    });

    it('clears device timer handles on teardown', async () => {
      const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
      const { entities, devices, initFn } = makeDeviceWithEntities();

      initFn.mockImplementation(function(this: { poll: (fn: () => void, opts: { interval: number }) => void }) {
        this.poll(() => {}, { interval: 5000 });
      });

      await manager.deploy(entities, devices);
      await manager.teardownAll();

      // poll uses chained timeouts — clearTimeout should be called for the poll ref
      expect(clearTimeoutSpy).toHaveBeenCalled();
    });
  });
});

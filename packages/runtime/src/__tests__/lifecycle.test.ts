import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EntityLifecycleManager } from '../lifecycle.js';
import type { Transport } from '../transport.js';
import type { ResolvedEntity, SensorDefinition, SwitchDefinition } from '@ha-ts-entities/sdk';

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

    // One clearTimeout for the setTimeout handle
    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
    // Two clearInterval calls: one for setInterval + one for poll
    expect(clearIntervalSpy).toHaveBeenCalledTimes(2);
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
});

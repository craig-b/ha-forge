import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HealthEntities } from '../health-entities.js';
import type { Transport } from '../transport.js';

function createMockTransport(): Transport & {
  register: ReturnType<typeof vi.fn>;
  publishState: ReturnType<typeof vi.fn>;
} {
  return {
    register: vi.fn(async () => {}),
    publishState: vi.fn(async () => {}),
    deregister: vi.fn(async () => {}),
    onCommand: vi.fn(),
  };
}

describe('HealthEntities', () => {
  let transport: ReturnType<typeof createMockTransport>;
  let health: HealthEntities;

  beforeEach(() => {
    transport = createMockTransport();
    health = new HealthEntities(transport);
  });

  it('registers two health entities on register()', async () => {
    await health.register();

    expect(transport.register).toHaveBeenCalledTimes(2);

    // Check binary_sensor registration
    const binarySensorCall = transport.register.mock.calls.find(
      (c: unknown[]) => (c[0] as { definition: { id: string } }).definition.id === 'ha_forge_build_healthy',
    );
    expect(binarySensorCall).toBeDefined();
    expect(binarySensorCall![0].definition.type).toBe('binary_sensor');

    // Check sensor registration
    const sensorCall = transport.register.mock.calls.find(
      (c: unknown[]) => (c[0] as { definition: { id: string } }).definition.id === 'ha_forge_type_errors',
    );
    expect(sensorCall).toBeDefined();
    expect(sensorCall![0].definition.type).toBe('sensor');
  });

  it('publishes initial healthy state', async () => {
    await health.register();

    // binary_sensor: off = no problem (device_class=problem)
    expect(transport.publishState).toHaveBeenCalledWith(
      'ha_forge_build_healthy',
      'off',
    );

    // sensor: 0 errors
    expect(transport.publishState).toHaveBeenCalledWith(
      'ha_forge_type_errors',
      0,
      expect.objectContaining({
        errors: [],
        check_trigger: 'build',
      }),
    );
  });

  it('updates state when type errors are found', async () => {
    await health.register();
    transport.publishState.mockClear();

    await health.update({
      diagnostics: [
        { file: 'test.ts', line: 5, column: 3, code: 2345, message: 'Type mismatch', severity: 'error' },
        { file: 'test.ts', line: 10, column: 1, code: 2304, message: 'Cannot find name', severity: 'error' },
      ],
      trigger: 'scheduled',
    });

    // binary_sensor: on = problem detected
    expect(transport.publishState).toHaveBeenCalledWith(
      'ha_forge_build_healthy',
      'on',
    );

    // sensor: 2 errors with details
    expect(transport.publishState).toHaveBeenCalledWith(
      'ha_forge_type_errors',
      2,
      expect.objectContaining({
        errors: expect.arrayContaining([
          expect.objectContaining({ file: 'test.ts', line: 5, message: 'Type mismatch' }),
        ]),
        check_trigger: 'scheduled',
        last_checked: expect.any(String),
      }),
    );
  });

  it('returns to healthy when errors are resolved', async () => {
    await health.register();

    // First: errors
    await health.update({
      diagnostics: [
        { file: 'a.ts', line: 1, column: 1, code: 1, message: 'err', severity: 'error' },
      ],
      trigger: 'build',
    });
    expect(health.getBuildHealthy()).toBe(false);

    // Then: no errors
    transport.publishState.mockClear();
    await health.update({
      diagnostics: [],
      trigger: 'build',
    });

    expect(health.getBuildHealthy()).toBe(true);
    expect(transport.publishState).toHaveBeenCalledWith(
      'ha_forge_build_healthy',
      'off', // no problem
    );
  });

  it('ignores warnings when counting errors', async () => {
    await health.register();
    transport.publishState.mockClear();

    await health.update({
      diagnostics: [
        { file: 'a.ts', line: 1, column: 1, code: 6133, message: 'unused', severity: 'warning' },
      ],
      trigger: 'build',
    });

    expect(health.getBuildHealthy()).toBe(true);
    expect(health.getTypeErrors()).toHaveLength(0);
  });

  it('does not publish if not registered yet', async () => {
    // update before register
    await health.update({
      diagnostics: [{ file: 'x.ts', line: 1, column: 1, code: 1, message: 'err', severity: 'error' }],
      trigger: 'build',
    });

    expect(transport.publishState).not.toHaveBeenCalled();
    expect(health.getBuildHealthy()).toBe(false);
  });
});

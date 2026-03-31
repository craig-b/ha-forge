import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { bundle } from '../packages/build/src/bundler.js';
import { loadSingleBundle } from '../packages/runtime/src/loader.js';
import { EntityLifecycleManager } from '../packages/runtime/src/lifecycle.js';
import { BuildManager } from '../packages/runtime/src/build-manager.js';
import { DeployManifestManager } from '../packages/runtime/src/deploy-manifest.js';
import type { Transport } from '../packages/runtime/src/transport.js';
import type { ResolvedEntity } from '../packages/sdk/src/types.js';

function createMockTransport() {
  const registered: ResolvedEntity[] = [];
  const states: Array<{ entityId: string; state: unknown; attributes?: Record<string, unknown> }> = [];
  const commandHandlers = new Map<string, (command: unknown) => void>();

  const transport: Transport = {
    supports: vi.fn(() => true),
    register: vi.fn(async (entity: ResolvedEntity) => {
      registered.push(entity);
    }),
    publishState: vi.fn(async (entityId: string, state: unknown, attributes?: Record<string, unknown>) => {
      states.push({ entityId, state, attributes });
    }),
    onCommand: vi.fn((entityId: string, handler: (command: unknown) => void) => {
      commandHandlers.set(entityId, handler);
    }),
    deregister: vi.fn(async () => {}),
  };

  return { transport, registered, states, commandHandlers };
}

function createMockLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

async function loadAllBundles(outputDir: string) {
  const jsFiles = fs.readdirSync(outputDir).filter((f) => f.endsWith('.js') && !f.endsWith('.js.map'));
  const entities: ResolvedEntity[] = [];
  for (const file of jsFiles) {
    const result = await loadSingleBundle(path.join(outputDir, file), outputDir);
    entities.push(...result.entities);
  }
  return entities;
}

describe('End-to-end: TS → bundle → load → register → state', () => {
  let inputDir: string;
  let outputDir: string;

  beforeEach(() => {
    inputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-input-'));
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-output-'));
  });

  it('builds, loads, and deploys a sensor entity', async () => {
    // Step 1: Write a user TypeScript file that defines a sensor
    const userScript = `
      export const temp = {
        id: 'backyard_temp',
        name: 'Temperature',
        type: 'sensor' as const,
        config: {
          device_class: 'temperature',
          unit_of_measurement: '°C',
          state_class: 'measurement',
        },
        init() {
          return 22.5;
        },
      };
    `;
    fs.writeFileSync(path.join(inputDir, 'weather.ts'), userScript);

    // Step 2: Bundle it
    const bundleResult = await bundle({
      inputDir,
      outputDir,
    });
    expect(bundleResult.success).toBe(true);
    expect(bundleResult.files).toHaveLength(1);
    expect(bundleResult.files[0].success).toBe(true);

    // Step 3: Load the bundle
    const bundlePath = path.join(outputDir, 'weather.js');
    const loadResult = await loadSingleBundle(bundlePath, outputDir);
    expect(loadResult.entities).toHaveLength(1);

    const entity = loadResult.entities[0];
    expect(entity.definition.id).toBe('backyard_temp');
    expect(entity.definition.type).toBe('sensor');
    expect(entity.sourceFile).toBe('weather.ts');
    expect(entity.deviceId).toBe('weather'); // grouped by file name

    // Step 4: Deploy through lifecycle manager
    const { transport, registered, states } = createMockTransport();
    const logger = createMockLogger();
    const lifecycle = new EntityLifecycleManager(transport, logger);

    await lifecycle.deploy(loadResult.entities);

    // Verify: entity was registered with the transport
    expect(registered).toHaveLength(1);
    expect(registered[0].definition.id).toBe('backyard_temp');

    // Verify: init() returned 22.5, which was published as initial state
    expect(states).toHaveLength(1);
    expect(states[0].entityId).toBe('backyard_temp');
    expect(states[0].state).toBe(22.5);

    // Verify: lifecycle reports entity as initialized
    expect(lifecycle.isInitialized('backyard_temp')).toBe(true);
    expect(lifecycle.getEntityState('backyard_temp')).toBe(22.5);
  });

  it('handles multiple entities across multiple files', async () => {
    const file1 = `
      export const a = { id: 'sensor_a', name: 'A', type: 'sensor' as const, init() { return 1; } };
      export const b = { id: 'sensor_b', name: 'B', type: 'sensor' as const, init() { return 2; } };
    `;
    const file2 = `
      export const c = { id: 'sensor_c', name: 'C', type: 'sensor' as const, init() { return 3; } };
    `;
    fs.writeFileSync(path.join(inputDir, 'group1.ts'), file1);
    fs.writeFileSync(path.join(inputDir, 'group2.ts'), file2);

    const bundleResult = await bundle({ inputDir, outputDir });
    expect(bundleResult.success).toBe(true);

    const entities = await loadAllBundles(outputDir);
    expect(entities).toHaveLength(3);

    const { transport, states } = createMockTransport();
    const lifecycle = new EntityLifecycleManager(transport, createMockLogger());

    await lifecycle.deploy(entities);

    expect(states).toHaveLength(3);
    expect(lifecycle.getEntityIds().sort()).toEqual(['sensor_a', 'sensor_b', 'sensor_c']);
  });

  it('isolates failures — one bad file does not block others', async () => {
    const good = `
      export const ok = { id: 'good_sensor', name: 'Good', type: 'sensor' as const, init() { return 42; } };
    `;
    const bad = `
      export const broken = {
        id: 'bad_sensor',
        name: 'Bad',
        type: 'sensor' as const,
        init() { throw new Error('init failed'); },
      };
    `;
    fs.writeFileSync(path.join(inputDir, 'good.ts'), good);
    fs.writeFileSync(path.join(inputDir, 'bad.ts'), bad);

    const bundleResult = await bundle({ inputDir, outputDir });
    expect(bundleResult.success).toBe(true);

    const entities = await loadAllBundles(outputDir);
    expect(entities).toHaveLength(2);

    const { transport, states } = createMockTransport();
    const logger = createMockLogger();
    const lifecycle = new EntityLifecycleManager(transport, logger);

    await lifecycle.deploy(entities);

    // Good sensor should work
    expect(lifecycle.isInitialized('good_sensor')).toBe(true);
    expect(lifecycle.getEntityState('good_sensor')).toBe(42);

    // Bad sensor should have failed but not blocked the good one
    expect(lifecycle.isInitialized('bad_sensor')).toBe(false);
    expect(logger.error).toHaveBeenCalled();
  });

  it('builds and deploys a switch that receives commands', async () => {
    const switchScript = `
      export const pump = {
        id: 'pump',
        name: 'Pump',
        type: 'switch' as const,
        config: { device_class: 'switch' },
        onCommand(cmd: string) {
          if (cmd === 'ON') {
            this.update('on');
          } else {
            this.update('off');
          }
        },
        init() {
          return 'off';
        },
      };
    `;
    fs.writeFileSync(path.join(inputDir, 'pump.ts'), switchScript);

    const bundleResult = await bundle({ inputDir, outputDir });
    expect(bundleResult.success).toBe(true);

    const loadResult = await loadSingleBundle(path.join(outputDir, 'pump.js'), outputDir);
    expect(loadResult.entities).toHaveLength(1);
    expect(loadResult.entities[0].definition.type).toBe('switch');
    expect('onCommand' in loadResult.entities[0].definition).toBe(true);

    const { transport, states, commandHandlers } = createMockTransport();
    const lifecycle = new EntityLifecycleManager(transport, createMockLogger());

    await lifecycle.deploy(loadResult.entities);

    // Initial state from init()
    expect(states).toHaveLength(1);
    expect(states[0]).toEqual({ entityId: 'pump', state: 'off', attributes: undefined });

    // Simulate HA sending ON command via transport
    const handler = commandHandlers.get('pump');
    expect(handler).toBeDefined();
    handler!('ON');

    // The onCommand calls this.update('on'), which triggers publishState
    await Promise.resolve(); // flush microtask
    expect(states.length).toBeGreaterThanOrEqual(2);
    expect(states[states.length - 1]).toEqual({
      entityId: 'pump',
      state: 'on',
      attributes: undefined,
    });

    // Toggle off
    handler!('OFF');
    await Promise.resolve();
    expect(states[states.length - 1]).toEqual({
      entityId: 'pump',
      state: 'off',
      attributes: undefined,
    });
  });

  it('redeploy tears down old entities and loads new ones', async () => {
    // First deploy
    const v1 = `export const s = { id: 'v1', name: 'V1', type: 'sensor' as const, init() { return 1; } };`;
    fs.writeFileSync(path.join(inputDir, 'app.ts'), v1);

    await bundle({ inputDir, outputDir });
    let entities = await loadAllBundles(outputDir);

    const { transport, states } = createMockTransport();
    const lifecycle = new EntityLifecycleManager(transport, createMockLogger());

    await lifecycle.deploy(entities);
    expect(lifecycle.getEntityIds()).toEqual(['v1']);

    // Second deploy with different entity
    const outputDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-output2-'));
    const v2 = `export const s = { id: 'v2', name: 'V2', type: 'sensor' as const, init() { return 2; } };`;
    fs.writeFileSync(path.join(inputDir, 'app.ts'), v2);

    await bundle({ inputDir, outputDir: outputDir2 });
    entities = await loadAllBundles(outputDir2);

    await lifecycle.deploy(entities);

    // Old entity torn down, new entity running
    expect(lifecycle.getEntityIds()).toEqual(['v2']);
    expect(lifecycle.getEntityState('v2')).toBe(2);
    expect(transport.deregister).toHaveBeenCalledWith('v1');

    fs.rmSync(outputDir2, { recursive: true, force: true });
  });
});

describe('Full pipeline: BuildManager.deployFromManifest', () => {
  let tmpDir: string;
  let bundleOutputDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-e2e-'));
    bundleOutputDir = path.join(tmpDir, 'dist');
    fs.mkdirSync(bundleOutputDir, { recursive: true });
  });

  it('deploys entities from manifest after bundle', async () => {
    const inputDir = path.join(tmpDir, 'scripts');
    fs.mkdirSync(inputDir, { recursive: true });

    fs.writeFileSync(
      path.join(inputDir, 'monitor.ts'),
      `
      export const cpuTemp = {
        id: 'sensor.cpu_temp',
        name: 'CPU Temperature',
        type: 'sensor' as const,
        init() { return 45.2; },
      };
      export const memUsage = {
        id: 'sensor.mem_usage',
        name: 'Memory Usage',
        type: 'sensor' as const,
        init() { return 67; },
      };
      `,
      'utf-8',
    );

    // Bundle
    const bundleResult = await bundle({ inputDir, outputDir: bundleOutputDir });
    expect(bundleResult.success).toBe(true);

    // Set up manifest
    const manifestManager = new DeployManifestManager(path.join(tmpDir, 'manifest.json'));
    manifestManager.setFile('monitor.ts', {
      commit: 'abc123',
      deployedAt: new Date().toISOString(),
      bundlePath: path.join(bundleOutputDir, 'monitor.js'),
    });

    // Deploy via BuildManager
    const { transport } = createMockTransport();
    const logger = createMockLogger();

    const manager = new BuildManager({
      bundleDir: bundleOutputDir,
      transport,
      logger,
    });

    const deployResult = await manager.deployFromManifest(manifestManager);

    expect(deployResult.success).toBe(true);
    expect(deployResult.entityCount).toBe(2);
    expect(deployResult.errors).toHaveLength(0);

    expect(manager.getEntityIds().sort()).toEqual(['sensor.cpu_temp', 'sensor.mem_usage']);
    expect(manager.getEntityState('sensor.cpu_temp')).toBe(45.2);
    expect(manager.getEntityState('sensor.mem_usage')).toBe(67);
  });
});

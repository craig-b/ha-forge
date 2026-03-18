import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runBuild, runValidation } from '../orchestrator.js';
import type { RegistryWSClient } from '../registry-fetcher.js';

// Minimal realistic HA data for type gen
function makeMinimalHAData() {
  return {
    services: {
      light: {
        turn_on: { fields: {} },
        turn_off: { fields: {} },
      },
    },
    states: [
      {
        entity_id: 'light.test',
        state: 'on',
        attributes: { friendly_name: 'Test Light' },
        last_changed: '2024-01-01T00:00:00.000Z',
        last_updated: '2024-01-01T00:00:00.000Z',
      },
    ],
    entities: [
      { entity_id: 'light.test', unique_id: 'u1', platform: 'mqtt' },
    ],
    devices: [],
    areas: [],
    labels: [],
  };
}

function createMockWSClient(data = makeMinimalHAData()): RegistryWSClient {
  return {
    sendCommand: vi.fn(async (type: string) => {
      switch (type) {
        case 'get_services': return data.services;
        case 'get_states': return data.states;
        case 'config/entity_registry/list': return data.entities;
        case 'config/device_registry/list': return data.devices;
        case 'config/area_registry/list': return data.areas;
        case 'config/label_registry/list': return data.labels;
        default: return null;
      }
    }),
    getHAVersion: vi.fn(() => '2024.3.0'),
  };
}

describe('runBuild', () => {
  let tmpDir: string;
  let scriptsDir: string;
  let generatedDir: string;
  let outputDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrator-test-'));
    scriptsDir = path.join(tmpDir, 'scripts');
    generatedDir = path.join(tmpDir, '.generated');
    outputDir = path.join(tmpDir, 'dist');
    fs.mkdirSync(scriptsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('runs all steps and returns unified result', async () => {
    // Write a simple .ts file to bundle
    fs.writeFileSync(
      path.join(scriptsDir, 'test.ts'),
      `export const x = 42;\n`,
      'utf-8',
    );

    const wsClient = createMockWSClient();
    const stepResults: string[] = [];

    const result = await runBuild({
      scriptsDir,
      generatedDir,
      outputDir,
      wsClient,
      skipNpmInstall: true,
      skipTscCheck: true,
      onStep: (step) => stepResults.push(step.step),
    });

    expect(result).toHaveProperty('success');
    expect(result).toHaveProperty('steps');
    expect(result).toHaveProperty('totalDuration');
    expect(result).toHaveProperty('timestamp');
    expect(result.totalDuration).toBeGreaterThanOrEqual(0);

    // type-gen and bundle should have run
    expect(stepResults).toContain('type-gen');
    expect(stepResults).toContain('bundle');
  });

  it('generates types when wsClient is provided', async () => {
    fs.writeFileSync(
      path.join(scriptsDir, 'test.ts'),
      `export const x = 1;\n`,
      'utf-8',
    );

    const wsClient = createMockWSClient();
    const result = await runBuild({
      scriptsDir,
      generatedDir,
      outputDir,
      wsClient,
      skipNpmInstall: true,
      skipTscCheck: true,
    });

    expect(result.typeGen).not.toBeNull();
    expect(result.typeGen!.success).toBe(true);
    expect(result.typeGen!.entityCount).toBe(1);

    // Generated files should exist
    expect(fs.existsSync(path.join(generatedDir, 'ha-registry.d.ts'))).toBe(true);
    expect(fs.existsSync(path.join(generatedDir, 'ha-validators.ts'))).toBe(true);
  });

  it('skips type gen when no wsClient', async () => {
    fs.writeFileSync(
      path.join(scriptsDir, 'test.ts'),
      `export const x = 1;\n`,
      'utf-8',
    );

    const result = await runBuild({
      scriptsDir,
      generatedDir,
      outputDir,
      skipNpmInstall: true,
      skipTscCheck: true,
    });

    expect(result.typeGen).toBeNull();
    const stepNames = result.steps.map((s) => s.step);
    expect(stepNames).not.toContain('type-gen');
  });

  it('bundles .ts files to outputDir', async () => {
    fs.writeFileSync(
      path.join(scriptsDir, 'hello.ts'),
      `export const greeting = 'hello world';\n`,
      'utf-8',
    );

    const result = await runBuild({
      scriptsDir,
      generatedDir,
      outputDir,
      skipNpmInstall: true,
      skipTscCheck: true,
    });

    expect(result.bundle).not.toBeNull();
    expect(result.bundle!.success).toBe(true);
    expect(result.bundle!.files).toHaveLength(1);
    expect(fs.existsSync(path.join(outputDir, 'hello.js'))).toBe(true);
  });

  it('succeeds with empty scripts directory', async () => {
    const result = await runBuild({
      scriptsDir,
      generatedDir,
      outputDir,
      skipNpmInstall: true,
      skipTscCheck: true,
    });

    expect(result.success).toBe(true);
    expect(result.bundle!.files).toHaveLength(0);
  });

  it('reports step-by-step progress via onStep callback', async () => {
    fs.writeFileSync(
      path.join(scriptsDir, 'test.ts'),
      `export const x = 1;\n`,
      'utf-8',
    );

    const wsClient = createMockWSClient();
    const steps: Array<{ step: string; success: boolean }> = [];

    await runBuild({
      scriptsDir,
      generatedDir,
      outputDir,
      wsClient,
      skipNpmInstall: true,
      skipTscCheck: true,
      onStep: (step) => steps.push({ step: step.step, success: step.success }),
    });

    expect(steps.length).toBeGreaterThanOrEqual(2);
    expect(steps[0].step).toBe('type-gen');
    expect(steps[steps.length - 1].step).toBe('bundle');
  });

  it('tsc errors do not block the build', async () => {
    fs.writeFileSync(
      path.join(scriptsDir, 'test.ts'),
      `export const x = 1;\n`,
      'utf-8',
    );

    const result = await runBuild({
      scriptsDir,
      generatedDir,
      outputDir,
      skipNpmInstall: true,
      skipTscCheck: false, // run tsc, but errors should not block
    });

    // The tsc step should be marked as success (non-blocking)
    const tscStep = result.steps.find((s) => s.step === 'tsc-check');
    if (tscStep) {
      expect(tscStep.success).toBe(true);
    }

    // Overall success depends only on bundle
    expect(result.bundle).not.toBeNull();
  });

  it('handles type gen failure gracefully', async () => {
    fs.writeFileSync(
      path.join(scriptsDir, 'test.ts'),
      `export const x = 1;\n`,
      'utf-8',
    );

    const failingClient: RegistryWSClient = {
      sendCommand: vi.fn(async () => { throw new Error('WS disconnected'); }),
      getHAVersion: vi.fn(() => null),
    };

    const result = await runBuild({
      scriptsDir,
      generatedDir,
      outputDir,
      wsClient: failingClient,
      skipNpmInstall: true,
      skipTscCheck: true,
    });

    // Type gen failed
    const typeGenStep = result.steps.find((s) => s.step === 'type-gen');
    expect(typeGenStep).toBeDefined();
    expect(typeGenStep!.success).toBe(false);

    // But bundle should still have run
    expect(result.bundle).not.toBeNull();

    // Overall build fails because type-gen is a blocking step
    expect(result.success).toBe(false);
  });
});

describe('runValidation', () => {
  let tmpDir: string;
  let scriptsDir: string;
  let generatedDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-test-'));
    scriptsDir = path.join(tmpDir, 'scripts');
    generatedDir = path.join(tmpDir, '.generated');
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.mkdirSync(generatedDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('regenerates types and runs tsc check', async () => {
    fs.writeFileSync(
      path.join(scriptsDir, 'test.ts'),
      `export const x: number = 42;\n`,
      'utf-8',
    );

    const wsClient = createMockWSClient();
    const tempDir = path.join(tmpDir, 'temp-gen');
    fs.mkdirSync(tempDir, { recursive: true });

    const result = await runValidation({
      scriptsDir,
      generatedDir,
      wsClient,
      tempDir,
    });

    expect(result).toHaveProperty('success');
    expect(result).toHaveProperty('typeGen');
    expect(result).toHaveProperty('diagnostics');
    expect(result).toHaveProperty('duration');
    expect(result).toHaveProperty('timestamp');
    expect(result.typeGen).not.toBeNull();
    expect(result.typeGen!.success).toBe(true);

    // Types should have been generated to tempDir
    expect(fs.existsSync(path.join(tempDir, 'ha-registry.d.ts'))).toBe(true);
  });

  it('returns failure when type gen fails', async () => {
    const failingClient: RegistryWSClient = {
      sendCommand: vi.fn(async () => { throw new Error('disconnected'); }),
      getHAVersion: vi.fn(() => null),
    };

    const result = await runValidation({
      scriptsDir,
      generatedDir,
      wsClient: failingClient,
    });

    expect(result.success).toBe(false);
  });
});

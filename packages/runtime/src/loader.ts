import * as path from 'node:path';
import * as fs from 'node:fs';
import type { EntityDefinition, EntityFactory, ResolvedEntity, EntityLogger, DeviceDefinition } from '@ha-ts-entities/sdk';
import type { HAClient } from './ha-api.js';

/** A resolved device definition with its source file and entity IDs. */
export interface ResolvedDevice {
  definition: DeviceDefinition;
  sourceFile: string;
  entityIds: string[];
}

export interface LoadResult {
  entities: ResolvedEntity[];
  devices: ResolvedDevice[];
  errors: LoadError[];
}

export interface LoadError {
  file: string;
  error: string;
}

/**
 * Install SDK functions as globals so user scripts can use sensor(), light(), etc.
 * without explicit imports. Call this before loading any user bundles.
 */
export async function installGlobals(haClient?: HAClient, logger?: EntityLogger): Promise<void> {
  const sdk = await import('@ha-ts-entities/sdk');
  const g = globalThis as Record<string, unknown>;
  g.sensor = sdk.sensor;
  g.defineSwitch = sdk.defineSwitch;
  g.light = sdk.light;
  g.cover = sdk.cover;
  g.climate = sdk.climate;
  g.entityFactory = sdk.entityFactory;
  g.device = sdk.device;

  // Always provide ha global — with full client or stub with working log
  const noopLogger: EntityLogger = {
    debug() {}, info() {}, warn() {}, error() {},
  };
  if (haClient) {
    g.ha = haClient;
  } else {
    const stubLog = logger ?? noopLogger;
    g.ha = {
      log: stubLog,
      on() { stubLog.warn('ha.on() unavailable — no WebSocket connection'); return () => {}; },
      async callService() { stubLog.warn('ha.callService() unavailable — no WebSocket connection'); return null; },
      async getState() { stubLog.warn('ha.getState() unavailable — no WebSocket connection'); return null; },
      async getEntities() { stubLog.warn('ha.getEntities() unavailable — no WebSocket connection'); return []; },
      async fireEvent() { stubLog.warn('ha.fireEvent() unavailable — no WebSocket connection'); },
      friendlyName(entityId: string) { return entityId; },
      reactions() { stubLog.warn('ha.reactions() unavailable — no WebSocket connection'); return () => {}; },
    } satisfies HAClient;
  }
}

/**
 * Load bundled JS files from a directory and extract entity definitions.
 *
 * Each file is expected to export entity definitions (from sensor(), switch(), etc.)
 * or an entity factory (from entityFactory()). Exports can be named or default.
 */
export async function loadBundles(bundleDir: string): Promise<LoadResult> {
  const entities: ResolvedEntity[] = [];
  const devices: ResolvedDevice[] = [];
  const errors: LoadError[] = [];

  if (!fs.existsSync(bundleDir)) {
    return { entities, devices, errors };
  }

  const jsFiles = findJsFiles(bundleDir);

  for (const file of jsFiles) {
    try {
      const result = await loadSingleBundle(file, bundleDir);
      entities.push(...result.entities);
      devices.push(...result.devices);
    } catch (err) {
      errors.push({
        file,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { entities, devices, errors };
}

async function loadSingleBundle(
  filePath: string,
  bundleDir: string,
): Promise<{ entities: ResolvedEntity[]; devices: ResolvedDevice[] }> {
  // Dynamic import — file:// URL required for absolute paths on all platforms.
  // Append a cache-busting query string so Node returns fresh modules on redeploy.
  const fileUrl = `file://${filePath}?t=${Date.now()}`;
  const mod = await import(fileUrl);

  const sourceFile = path.relative(bundleDir, filePath).replace(/\.js$/, '.ts');
  const fileBaseName = path.basename(filePath, '.js');

  const definitions: EntityDefinition[] = [];
  const factories: EntityFactory[] = [];
  const deviceDefs: DeviceDefinition[] = [];

  // Walk all exports — check devices first since they also have id/name
  for (const [, value] of Object.entries(mod)) {
    if (isDeviceDefinition(value)) {
      deviceDefs.push(value);
    } else if (isEntityDefinition(value)) {
      definitions.push(value);
    } else if (isEntityFactory(value)) {
      factories.push(value);
    }
  }

  // Resolve factories
  for (const factory of factories) {
    try {
      const result = await factory();
      definitions.push(...result);
    } catch (err) {
      throw new Error(
        `Factory in ${sourceFile} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Group standalone entities by device or file
  const entities: ResolvedEntity[] = definitions.map((definition) => {
    const deviceId = definition.device?.id ?? fileBaseName;
    return { definition, sourceFile, deviceId };
  });

  // Resolve device definitions into individual entities
  const devices: ResolvedDevice[] = [];
  for (const dev of deviceDefs) {
    const deviceInfo = {
      id: dev.id,
      name: dev.name,
      ...(dev.manufacturer && { manufacturer: dev.manufacturer }),
      ...(dev.model && { model: dev.model }),
      ...(dev.sw_version && { sw_version: dev.sw_version }),
      ...(dev.suggested_area && { suggested_area: dev.suggested_area }),
    };

    const entityIds: string[] = [];
    for (const [, entityDef] of Object.entries(dev.entities)) {
      // Stamp device info onto each entity
      entityDef.device = deviceInfo;
      entityIds.push(entityDef.id);
      entities.push({
        definition: entityDef,
        sourceFile,
        deviceId: dev.id,
      });
    }

    devices.push({ definition: dev, sourceFile, entityIds });
  }

  return { entities, devices };
}

function isDeviceDefinition(value: unknown): value is DeviceDefinition {
  return (
    typeof value === 'object' &&
    value !== null &&
    '__kind' in value &&
    (value as Record<string, unknown>).__kind === 'device'
  );
}

function isEntityDefinition(value: unknown): value is EntityDefinition {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    'name' in value &&
    'type' in value &&
    typeof (value as Record<string, unknown>).type === 'string'
  );
}

function isEntityFactory(value: unknown): value is EntityFactory {
  // A factory is a bare function (not an entity definition which is an object)
  return typeof value === 'function';
}

function findJsFiles(dir: string): string[] {
  const files: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...findJsFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.js') && !entry.name.endsWith('.js.map')) {
      files.push(fullPath);
    }
  }

  return files;
}

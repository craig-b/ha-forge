import type { ResolvedEntity } from '@ha-ts-entities/sdk';
import type { ResolvedDevice } from './loader.js';
import type { LifecycleLogger, RawMqttAccess } from './lifecycle.js';
import { EntityLifecycleManager } from './lifecycle.js';
import { loadBundles } from './loader.js';
import type { Transport } from './transport.js';
import type { HAClient } from './ha-api.js';

export interface BuildDeployOptions {
  /** Directory containing bundled .js files */
  bundleDir: string;
  /** Transport for MQTT communication */
  transport: Transport;
  /** Logger instance */
  logger: LifecycleLogger;
  /** Optional HA client for reactive API */
  haClient?: HAClient | null;
  /** Optional raw MQTT access for entity context */
  rawMqtt?: RawMqttAccess | null;
}

export interface DeployResult {
  success: boolean;
  entityCount: number;
  errors: Array<{ file: string; error: string }>;
  duration: number;
}

/**
 * Manages the load → deploy cycle with file-level isolation.
 * One file's failure doesn't block other files from deploying.
 */
export class BuildManager {
  private lifecycle: EntityLifecycleManager;
  private logger: LifecycleLogger;
  private bundleDir: string;

  constructor(opts: BuildDeployOptions) {
    this.lifecycle = new EntityLifecycleManager(
      opts.transport,
      opts.logger,
      opts.haClient,
      opts.rawMqtt,
    );
    this.logger = opts.logger;
    this.bundleDir = opts.bundleDir;
  }

  /**
   * Load bundled JS files and deploy entities.
   * Files that fail to load are skipped — their entities are not deployed,
   * but entities from other files proceed normally.
   */
  async deploy(): Promise<DeployResult> {
    const startTime = Date.now();

    // Load all bundles
    const loadResult = await loadBundles(this.bundleDir);

    if (loadResult.errors.length > 0) {
      for (const err of loadResult.errors) {
        this.logger.error(`Failed to load ${err.file}`, { error: err.error });
      }
    }

    if (loadResult.entities.length === 0 && loadResult.errors.length === 0) {
      this.logger.info('No entities to deploy');
      return {
        success: true,
        entityCount: 0,
        errors: loadResult.errors,
        duration: Date.now() - startTime,
      };
    }

    // Deploy entities with file-level isolation
    const deployErrors: Array<{ file: string; error: string }> = [...loadResult.errors];

    // Group entities by source file for isolation
    const byFile = new Map<string, ResolvedEntity[]>();
    for (const entity of loadResult.entities) {
      const file = entity.sourceFile;
      let group = byFile.get(file);
      if (!group) {
        group = [];
        byFile.set(file, group);
      }
      group.push(entity);
    }

    // Teardown all existing entities first
    await this.lifecycle.teardownAll();

    // Group devices by source file for isolation
    const devicesByFile = new Map<string, ResolvedDevice[]>();
    for (const device of loadResult.devices) {
      const file = device.sourceFile;
      let group = devicesByFile.get(file);
      if (!group) {
        group = [];
        devicesByFile.set(file, group);
      }
      group.push(device);
    }

    // Deploy each file's entities independently
    let deployedCount = 0;
    for (const [file, entities] of byFile) {
      try {
        const devices = devicesByFile.get(file) ?? [];
        await this.lifecycle.deployAdditive(entities, devices);
        deployedCount += entities.length;
        this.logger.info(`Deployed ${entities.length} entities from ${file}`);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        deployErrors.push({ file, error: errorMsg });
        this.logger.error(`Failed to deploy entities from ${file}`, {
          error: errorMsg,
          entityIds: entities.map((e) => e.definition.id),
        });
      }
    }

    return {
      success: deployErrors.length === 0,
      entityCount: deployedCount,
      errors: deployErrors,
      duration: Date.now() - startTime,
    };
  }

  /**
   * Teardown all currently running entities.
   */
  async teardownAll(): Promise<void> {
    await this.lifecycle.teardownAll();
  }

  getEntityIds(): string[] {
    return this.lifecycle.getEntityIds();
  }

  getEntityState(entityId: string): unknown {
    return this.lifecycle.getEntityState(entityId);
  }

  getEntityInfo(entityId: string): { type: string; name: string; sourceFile: string } | undefined {
    return this.lifecycle.getEntityInfo(entityId);
  }
}

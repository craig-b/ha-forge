import type { ResolvedEntity } from '@ha-forge/sdk/internal';
import type { ResolvedDevice } from './loader.js';
import type { LifecycleLogger, RawMqttAccess } from './lifecycle.js';
import { EntityLifecycleManager } from './lifecycle.js';
import { loadBundles } from './loader.js';
import type { Transport } from './transport.js';

export interface BuildDeployOptions {
  /** Directory containing bundled .js files */
  bundleDir: string;
  /** Transport for MQTT communication */
  transport: Transport;
  /** Logger instance */
  logger: LifecycleLogger;
  /** Optional raw MQTT access for entity context */
  rawMqtt?: RawMqttAccess | null;
  /** Called when any entity's state changes (for WebSocket broadcasting) */
  onEntityStateChange?: (entityId: string, state: unknown) => void;
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
      opts.rawMqtt,
      opts.onEntityStateChange,
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
   * Smart deploy: load bundles, diff against running entities, only redeploy changed files.
   * Entities from unchanged files keep running without interruption.
   */
  async smartDeploy(): Promise<DeployResult> {
    const startTime = Date.now();
    const loadResult = await loadBundles(this.bundleDir);

    if (loadResult.errors.length > 0) {
      for (const err of loadResult.errors) {
        this.logger.error(`Failed to load ${err.file}`, { error: err.error });
      }
    }

    // Group new entities and devices by source file
    const newByFile = new Map<string, ResolvedEntity[]>();
    for (const entity of loadResult.entities) {
      let group = newByFile.get(entity.sourceFile);
      if (!group) { group = []; newByFile.set(entity.sourceFile, group); }
      group.push(entity);
    }
    const newDevicesByFile = new Map<string, ResolvedDevice[]>();
    for (const device of loadResult.devices) {
      let group = newDevicesByFile.get(device.sourceFile);
      if (!group) { group = []; newDevicesByFile.set(device.sourceFile, group); }
      group.push(device);
    }

    // Determine which files actually changed
    const activeFiles = this.lifecycle.getActiveSourceFiles();
    const allFiles = new Set([...activeFiles, ...newByFile.keys()]);
    const changedFiles = new Set<string>();

    for (const file of allFiles) {
      const oldEntities = this.lifecycle.getEntitiesBySourceFile(file);
      const newEntities = newByFile.get(file) ?? [];

      if (!this.entitiesMatch(oldEntities, newEntities)) {
        changedFiles.add(file);
      }
    }

    if (changedFiles.size === 0) {
      this.logger.info('No entity changes detected, skipping redeploy');
      return { success: true, entityCount: this.lifecycle.getEntityIds().length, errors: loadResult.errors, duration: Date.now() - startTime };
    }

    this.logger.info(`${changedFiles.size}/${allFiles.size} files changed, redeploying selectively`);

    // Teardown only changed files
    await this.lifecycle.teardownBySourceFiles(changedFiles);

    // Deploy new entities for changed files
    const deployErrors: Array<{ file: string; error: string }> = [...loadResult.errors];
    let deployedCount = 0;
    for (const file of changedFiles) {
      const entities = newByFile.get(file);
      if (!entities) continue; // File was removed — already torn down
      try {
        const devices = newDevicesByFile.get(file) ?? [];
        await this.lifecycle.deployAdditive(entities, devices);
        deployedCount += entities.length;
        this.logger.info(`Redeployed ${entities.length} entities from ${file}`);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        deployErrors.push({ file, error: errorMsg });
        this.logger.error(`Failed to redeploy entities from ${file}`, { error: errorMsg });
      }
    }

    return {
      success: deployErrors.length === 0,
      entityCount: this.lifecycle.getEntityIds().length,
      errors: deployErrors,
      duration: Date.now() - startTime,
    };
  }

  /** Compare two sets of entities by their serializable definition properties. */
  private entitiesMatch(a: ResolvedEntity[], b: ResolvedEntity[]): boolean {
    if (a.length !== b.length) return false;

    // Sort both by entity ID for stable comparison
    const sortById = (entities: ResolvedEntity[]) =>
      [...entities].sort((x, y) => x.definition.id.localeCompare(y.definition.id));

    const sortedA = sortById(a);
    const sortedB = sortById(b);

    for (let i = 0; i < sortedA.length; i++) {
      const defA = sortedA[i].definition;
      const defB = sortedB[i].definition;
      // Compare the serializable parts: id, name, type, and config
      if (defA.id !== defB.id || defA.name !== defB.name || defA.type !== defB.type) return false;
      // For functions (init, onCommand, destroy), compare their string representations
      // This catches code changes even when the definition shape is the same
      if (String(defA.init) !== String(defB.init)) return false;
      if (String((defA as unknown as Record<string, unknown>).onCommand) !== String((defB as unknown as Record<string, unknown>).onCommand)) return false;
      if (String(defA.destroy) !== String(defB.destroy)) return false;
    }
    return true;
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

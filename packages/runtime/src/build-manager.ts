import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { ResolvedEntity } from '@ha-forge/sdk/internal';
import type { ResolvedAutomation, ResolvedCron, ResolvedDevice, ResolvedMode, ResolvedTask } from './loader.js';
import type { LifecycleLogger, RawMqttAccess } from './lifecycle.js';
import { EntityLifecycleManager } from './lifecycle.js';
import { loadBundles, loadSingleBundle } from './loader.js';
import type { GitService } from './git-service.js';
import type { DeployManifestManager } from './deploy-manifest.js';
import type { Transport } from './transport.js';
import type { HAApiImpl } from './ha-api.js';

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
  /** Optional HA API for providing this.ha and this.events to entities */
  haApi?: HAApiImpl | null;
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
  /** Content hashes of deployed bundle files, keyed by source file (e.g. 'foo.ts'). */
  private deployedHashes = new Map<string, string>();

  constructor(opts: BuildDeployOptions) {
    this.lifecycle = new EntityLifecycleManager(
      opts.transport,
      opts.logger,
      opts.rawMqtt,
      opts.onEntityStateChange,
      opts.haApi,
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

    const hasWork = loadResult.entities.length > 0 || loadResult.devices.length > 0 || loadResult.automations.length > 0 || loadResult.tasks.length > 0 || loadResult.modes.length > 0 || loadResult.crons.length > 0;
    if (!hasWork && loadResult.errors.length === 0) {
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

    // Group automations and tasks by source file
    const automationsByFile = new Map<string, ResolvedAutomation[]>();
    for (const auto of loadResult.automations) {
      let group = automationsByFile.get(auto.sourceFile);
      if (!group) { group = []; automationsByFile.set(auto.sourceFile, group); }
      group.push(auto);
    }
    const tasksByFile = new Map<string, ResolvedTask[]>();
    for (const t of loadResult.tasks) {
      let group = tasksByFile.get(t.sourceFile);
      if (!group) { group = []; tasksByFile.set(t.sourceFile, group); }
      group.push(t);
    }
    const modesByFile = new Map<string, ResolvedMode[]>();
    for (const m of loadResult.modes) {
      let group = modesByFile.get(m.sourceFile);
      if (!group) { group = []; modesByFile.set(m.sourceFile, group); }
      group.push(m);
    }
    const cronsByFile = new Map<string, ResolvedCron[]>();
    for (const c of loadResult.crons) {
      let group = cronsByFile.get(c.sourceFile);
      if (!group) { group = []; cronsByFile.set(c.sourceFile, group); }
      group.push(c);
    }

    // Collect all source files (include devicesByFile for devices with lifecycle-only init/destroy)
    const allFiles = new Set([...byFile.keys(), ...devicesByFile.keys(), ...automationsByFile.keys(), ...tasksByFile.keys(), ...modesByFile.keys(), ...cronsByFile.keys()]);

    // Deploy each file's definitions independently
    let deployedCount = 0;
    for (const file of allFiles) {
      try {
        const entities = byFile.get(file) ?? [];
        const devices = devicesByFile.get(file) ?? [];
        const automations = automationsByFile.get(file) ?? [];
        const tasks = tasksByFile.get(file) ?? [];
        const modes = modesByFile.get(file) ?? [];
        const crons = cronsByFile.get(file) ?? [];
        await this.lifecycle.deployAdditive(entities, devices, automations, tasks, modes, crons);
        deployedCount += entities.length + automations.length + tasks.length + modes.length + crons.length;
        this.logger.info(`Deployed ${entities.length} entities, ${automations.length} automations, ${tasks.length} tasks, ${modes.length} modes, ${crons.length} crons from ${file}`);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        deployErrors.push({ file, error: errorMsg });
        this.logger.error(`Failed to deploy from ${file}`, { error: errorMsg });
      }
    }

    // Store content hashes for smart deploy diffing
    this.deployedHashes = this.hashBundleFiles();

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

    // Group new entities, devices, automations, and tasks by source file
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
    const newAutomationsByFile = new Map<string, ResolvedAutomation[]>();
    for (const auto of loadResult.automations) {
      let group = newAutomationsByFile.get(auto.sourceFile);
      if (!group) { group = []; newAutomationsByFile.set(auto.sourceFile, group); }
      group.push(auto);
    }
    const newTasksByFile = new Map<string, ResolvedTask[]>();
    for (const t of loadResult.tasks) {
      let group = newTasksByFile.get(t.sourceFile);
      if (!group) { group = []; newTasksByFile.set(t.sourceFile, group); }
      group.push(t);
    }
    const newModesByFile = new Map<string, ResolvedMode[]>();
    for (const m of loadResult.modes) {
      let group = newModesByFile.get(m.sourceFile);
      if (!group) { group = []; newModesByFile.set(m.sourceFile, group); }
      group.push(m);
    }
    const newCronsByFile = new Map<string, ResolvedCron[]>();
    for (const c of loadResult.crons) {
      let group = newCronsByFile.get(c.sourceFile);
      if (!group) { group = []; newCronsByFile.set(c.sourceFile, group); }
      group.push(c);
    }

    // Determine which files actually changed by comparing bundle content hashes
    const currentHashes = this.hashBundleFiles();
    const allFiles = new Set([...this.deployedHashes.keys(), ...currentHashes.keys()]);
    const changedFiles = new Set<string>();

    for (const file of allFiles) {
      if (this.deployedHashes.get(file) !== currentHashes.get(file)) {
        changedFiles.add(file);
      }
    }

    if (changedFiles.size === 0) {
      this.logger.info('No changes detected, skipping redeploy');
      return { success: true, entityCount: this.lifecycle.getEntityIds().length, errors: loadResult.errors, duration: Date.now() - startTime };
    }

    this.logger.info(`${changedFiles.size}/${allFiles.size} files changed, redeploying selectively`);

    // Teardown only changed files
    await this.lifecycle.teardownBySourceFiles(changedFiles);

    // Deploy new definitions for changed files
    const deployErrors: Array<{ file: string; error: string }> = [...loadResult.errors];
    let deployedCount = 0;
    for (const file of changedFiles) {
      const entities = newByFile.get(file) ?? [];
      const devices = newDevicesByFile.get(file) ?? [];
      const automations = newAutomationsByFile.get(file) ?? [];
      const tasks = newTasksByFile.get(file) ?? [];
      const modes = newModesByFile.get(file) ?? [];
      const crons = newCronsByFile.get(file) ?? [];
      if (entities.length === 0 && devices.length === 0 && automations.length === 0 && tasks.length === 0 && modes.length === 0 && crons.length === 0) continue; // File was removed
      try {
        await this.lifecycle.deployAdditive(entities, devices, automations, tasks, modes, crons);
        deployedCount += entities.length + automations.length + tasks.length + modes.length + crons.length;
        this.logger.info(`Redeployed from ${file}`);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        deployErrors.push({ file, error: errorMsg });
        this.logger.error(`Failed to redeploy from ${file}`, { error: errorMsg });
      }
    }

    // Update stored hashes for successfully redeployed files
    for (const file of changedFiles) {
      const hash = currentHashes.get(file);
      if (hash) {
        this.deployedHashes.set(file, hash);
      } else {
        this.deployedHashes.delete(file); // File was removed
      }
    }

    return {
      success: deployErrors.length === 0,
      entityCount: this.lifecycle.getEntityIds().length,
      errors: deployErrors,
      duration: Date.now() - startTime,
    };
  }

  /** Hash all JS bundle files in the bundle directory, keyed by source file name (e.g. 'foo.ts'). */
  private hashBundleFiles(): Map<string, string> {
    const hashes = new Map<string, string>();
    if (!fs.existsSync(this.bundleDir)) return hashes;

    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (entry.isFile() && entry.name.endsWith('.js') && !entry.name.endsWith('.js.map')) {
          const sourceFile = path.relative(this.bundleDir, fullPath).replace(/\.js$/, '.ts');
          const content = fs.readFileSync(fullPath);
          hashes.set(sourceFile, crypto.createHash('sha256').update(content).digest('hex'));
        }
      }
    };
    walk(this.bundleDir);
    return hashes;
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

  getEntityInfo(entityId: string): { type: string; name: string; sourceFile: string; unit_of_measurement?: string; next_fire?: string; cron_description?: string } | undefined {
    return this.lifecycle.getEntityInfo(entityId);
  }

  /**
   * Deploy a specific committed version of a single file.
   * Extracts the file from git at the given commit, bundles it,
   * stores the bundle in deployedBundlesDir, and deploys its entities.
   */
  async deploySingleFile(opts: {
    filename: string;
    commit: string;
    gitService: GitService;
    manifestManager: DeployManifestManager;
    deployedBundlesDir: string;
    buildFn: (stagingDir: string, filename: string, outputDir: string) => Promise<void>;
  }): Promise<DeployResult> {
    const startTime = Date.now();
    const { filename, commit, gitService, manifestManager, deployedBundlesDir } = opts;
    const os = await import('node:os');

    const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-forge-deploy-'));

    try {
      // Extract file at the target commit
      const content = await gitService.getFileAtCommit(commit, path.join(this.bundleDir, '..', filename));
      if (content === null) {
        return {
          success: false, entityCount: 0, duration: Date.now() - startTime,
          errors: [{ file: filename, error: `File not found at commit ${commit}` }],
        };
      }
      fs.writeFileSync(path.join(stagingDir, filename), content, 'utf-8');

      // Extract sidecar if it exists at that commit
      const sidecarName = filename.replace(/\.ts$/, '.package.json');
      const sidecarContent = await gitService.getFileAtCommit(
        commit, path.join(this.bundleDir, '..', sidecarName),
      );
      if (sidecarContent !== null) {
        fs.writeFileSync(path.join(stagingDir, sidecarName), sidecarContent, 'utf-8');
      }

      // Build (caller provides the build function to avoid circular deps)
      fs.mkdirSync(deployedBundlesDir, { recursive: true });
      await opts.buildFn(stagingDir, filename, deployedBundlesDir);

      // Teardown old entities from this file
      await this.lifecycle.teardownBySourceFiles(new Set([filename]));

      // Load and deploy the new bundle
      const bundlePath = path.join(deployedBundlesDir, filename.replace(/\.ts$/, '.js'));
      if (!fs.existsSync(bundlePath)) {
        return {
          success: false, entityCount: 0, duration: Date.now() - startTime,
          errors: [{ file: filename, error: 'Bundle not produced' }],
        };
      }
      const result = await loadSingleBundle(bundlePath, deployedBundlesDir);

      await this.lifecycle.deployAdditive(
        result.entities, result.devices, result.automations,
        result.tasks, result.modes, result.crons,
      );
      const entityCount = result.entities.length + result.automations.length +
        result.tasks.length + result.modes.length + result.crons.length;

      // Update manifest
      manifestManager.setFile(filename, {
        commit,
        deployedAt: new Date().toISOString(),
        bundlePath,
      });

      this.logger.info(`Deployed ${filename} at commit ${commit.slice(0, 7)}: ${entityCount} entities`);

      return {
        success: true, entityCount, errors: [], duration: Date.now() - startTime,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to deploy ${filename}`, { error: errorMsg });
      return {
        success: false, entityCount: 0, duration: Date.now() - startTime,
        errors: [{ file: filename, error: errorMsg }],
      };
    } finally {
      // Clean up staging dir
      try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }

  /**
   * Undeploy a file — tear down its entities, remove from manifest, delete bundle.
   */
  async undeployFile(filename: string, manifestManager: DeployManifestManager, deployedBundlesDir: string): Promise<void> {
    await this.lifecycle.teardownBySourceFiles(new Set([filename]));
    manifestManager.removeFile(filename);
    const bundlePath = path.join(deployedBundlesDir, filename.replace(/\.ts$/, '.js'));
    try { fs.unlinkSync(bundlePath); } catch { /* may not exist */ }
    this.logger.info(`Undeployed ${filename}`);
  }
}

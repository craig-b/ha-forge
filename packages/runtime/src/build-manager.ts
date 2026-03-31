import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ResolvedEntity } from '@ha-forge/sdk/internal';
import type { ResolvedAutomation, ResolvedCron, ResolvedDevice, ResolvedMode, ResolvedTask } from './loader.js';
import type { LifecycleLogger, RawMqttAccess } from './lifecycle.js';
import { EntityLifecycleManager } from './lifecycle.js';
import { loadSingleBundle } from './loader.js';
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
   * Load entities from manifest on startup.
   * Reads the manifest to determine which bundles to load,
   * then loads and deploys each one individually.
   */
  async deployFromManifest(manifestManager: DeployManifestManager): Promise<DeployResult> {
    const startTime = Date.now();
    const manifest = manifestManager.read();
    const filenames = Object.keys(manifest.files);

    if (filenames.length === 0) {
      this.logger.info('No files in deploy manifest');
      return { success: true, entityCount: 0, errors: [], duration: Date.now() - startTime };
    }

    const deployErrors: Array<{ file: string; error: string }> = [];
    let deployedCount = 0;

    for (const filename of filenames) {
      const entry = manifest.files[filename];
      const bundlePath = entry.bundlePath;

      if (!fs.existsSync(bundlePath)) {
        deployErrors.push({ file: filename, error: `Bundle not found: ${bundlePath}` });
        this.logger.error(`Bundle not found for ${filename}`, { bundlePath });
        continue;
      }

      try {
        const result = await loadSingleBundle(bundlePath, this.bundleDir);
        await this.lifecycle.deployAdditive(
          result.entities, result.devices, result.automations,
          result.tasks, result.modes, result.crons,
        );
        const count = result.entities.length + result.automations.length +
          result.tasks.length + result.modes.length + result.crons.length;
        deployedCount += count;
        this.logger.info(`Loaded ${filename}: ${count} entities`);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        deployErrors.push({ file: filename, error: errorMsg });
        this.logger.error(`Failed to load ${filename}`, { error: errorMsg });
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
    scriptsDir: string;
    buildFn: (stagingDir: string, filename: string, outputDir: string) => Promise<void>;
  }): Promise<DeployResult> {
    const startTime = Date.now();
    const { filename, commit, gitService, manifestManager, deployedBundlesDir, scriptsDir } = opts;
    const os = await import('node:os');

    const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-forge-deploy-'));

    try {
      // Extract file at the target commit
      const content = await gitService.getFileAtCommit(commit, path.join(scriptsDir, filename));
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
        commit, path.join(scriptsDir, sidecarName),
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

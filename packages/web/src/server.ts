import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { ingressGuard, ingressPath, getIngressPath } from './middleware.js';
import { createFilesRoutes } from './routes/files.js';
import type { GitService, DeployManifestManager } from '@ha-forge/runtime';
import { createBuildRoutes } from './routes/build.js';
import type { BuildTriggerFn, BuildStatusFn, DeployTriggerFn, DeployFileFn, UndeployFileFn, GetDeployManifestFn } from './routes/build.js';
import { createHistoryRoutes } from './routes/history.js';
import { createEntitiesRoutes } from './routes/entities.js';
import type { GetEntitiesFn } from './routes/entities.js';
import { createLogsRoutes } from './routes/logs.js';
import type { QueryLogsFn, GetLogEntityIdsFn } from './routes/logs.js';
import { createPackagesRoutes } from './routes/packages.js';
import { createTypesRoutes } from './routes/types.js';
import type { TypeRegenFn } from './routes/types.js';
import { createHARoutes } from './routes/ha.js';
import type { FetchFromHA } from './routes/ha.js';
import { createCapturesRoutes } from './routes/captures.js';
import { WSHub } from './ws-hub.js';
import { generateUIHtml } from './ui/index.js';

// ---- Server config ----

export interface WebServerConfig {
  /** Port to listen on (default: 8099) */
  port?: number;
  /** Directory containing user scripts */
  scriptsDir: string;
  /** Directory containing generated types */
  generatedDir: string;
  /** Function to trigger a build */
  triggerBuild: BuildTriggerFn;
  /** Function to get current build status */
  getBuildStatus: BuildStatusFn;
  /** Function to trigger a deploy */
  triggerDeploy: DeployTriggerFn;
  /** Function to get registered entities */
  getEntities: GetEntitiesFn;
  /** Function to query logs */
  queryLogs: QueryLogsFn;
  /** Function to get distinct entity IDs from log history */
  getLogEntityIds?: GetLogEntityIdsFn;
  /** Function to regenerate types */
  regenerateTypes: TypeRegenFn;
  /** Function to proxy requests to the HA REST API */
  fetchFromHA?: FetchFromHA;
  /** Directory for capture files */
  capturesDir?: string;
  /** Git service for auto-commit on save */
  gitService?: GitService;
  /** Deploy manifest manager */
  manifestManager?: DeployManifestManager;
  /** Deploy a specific version of a file */
  deployFile?: DeployFileFn;
  /** Undeploy a file */
  undeployFile?: UndeployFileFn;
  /** Get the deploy manifest */
  getDeployManifest?: GetDeployManifestFn;
}

// ---- Server creation ----

type Env = {
  Variables: {
    ingressPath: string;
  };
};

export function createServer(config: WebServerConfig) {
  const app = new Hono<Env>({ getPath: getIngressPath });
  const wsHub = new WSHub();

  // Middleware
  app.use('*', cors());
  app.use('*', ingressGuard());
  app.use('*', ingressPath());

  // API routes
  app.route('/api/files', createFilesRoutes({ scriptsDir: config.scriptsDir, gitService: config.gitService }));
  app.route('/api/build', createBuildRoutes({
    triggerBuild: config.triggerBuild,
    getBuildStatus: config.getBuildStatus,
    triggerDeploy: config.triggerDeploy,
    deployFile: config.deployFile,
    undeployFile: config.undeployFile,
    getDeployManifest: config.getDeployManifest,
  }));
  app.route('/api/entities', createEntitiesRoutes(config.getEntities));
  app.route('/api/logs', createLogsRoutes(config.queryLogs, config.getLogEntityIds));
  app.route('/api/packages', createPackagesRoutes({ scriptsDir: config.scriptsDir }));
  app.route('/api/types', createTypesRoutes({
    generatedDir: config.generatedDir,
    regenerateTypes: config.regenerateTypes,
  }));
  if (config.fetchFromHA) {
    app.route('/api/ha', createHARoutes({ fetchFromHA: config.fetchFromHA }));
  }
  if (config.capturesDir) {
    app.route('/api/captures', createCapturesRoutes({ capturesDir: config.capturesDir }));
  }
  if (config.gitService && config.manifestManager) {
    app.route('/api/history', createHistoryRoutes({
      scriptsDir: config.scriptsDir,
      gitService: config.gitService,
      manifestManager: config.manifestManager,
    }));
  }

  // UI — serve the single-page application
  app.get('/', (c) => {
    const ingressBase = c.get('ingressPath') as string | undefined ?? '';
    return c.html(generateUIHtml(ingressBase));
  });
  return { app, wsHub };
}

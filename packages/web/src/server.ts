import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { ingressGuard, ingressPath, getIngressPath } from './middleware.js';
import { createFilesRoutes } from './routes/files.js';
import { createBuildRoutes } from './routes/build.js';
import type { BuildTriggerFn, BuildStatusFn } from './routes/build.js';
import { createEntitiesRoutes } from './routes/entities.js';
import type { GetEntitiesFn } from './routes/entities.js';
import { createLogsRoutes } from './routes/logs.js';
import type { QueryLogsFn } from './routes/logs.js';
import { createPackagesRoutes } from './routes/packages.js';
import { createTypesRoutes } from './routes/types.js';
import type { TypeRegenFn } from './routes/types.js';
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
  /** Function to get registered entities */
  getEntities: GetEntitiesFn;
  /** Function to query logs */
  queryLogs: QueryLogsFn;
  /** Function to regenerate types */
  regenerateTypes: TypeRegenFn;
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
  app.route('/api/files', createFilesRoutes({ scriptsDir: config.scriptsDir }));
  app.route('/api/build', createBuildRoutes({
    triggerBuild: config.triggerBuild,
    getBuildStatus: config.getBuildStatus,
  }));
  app.route('/api/entities', createEntitiesRoutes(config.getEntities));
  app.route('/api/logs', createLogsRoutes(config.queryLogs));
  app.route('/api/packages', createPackagesRoutes({ scriptsDir: config.scriptsDir }));
  app.route('/api/types', createTypesRoutes({
    generatedDir: config.generatedDir,
    regenerateTypes: config.regenerateTypes,
  }));

  // UI — serve the single-page application
  app.get('/', (c) => {
    const ingressBase = c.get('ingressPath') as string | undefined ?? '';
    return c.html(generateUIHtml(ingressBase));
  });
  return { app, wsHub };
}

import { Hono } from 'hono';

export type BuildTriggerFn = () => Promise<BuildStatusResponse>;
export type BuildStatusFn = () => BuildStatusResponse;
export type DeployTriggerFn = () => Promise<DeployResponse>;
export type DeployFileFn = (filename: string, commit: string) => Promise<DeployResponse>;
export type UndeployFileFn = (filename: string) => Promise<void>;
export type GetDeployManifestFn = () => DeployManifestResponse;

export interface BuildStatusResponse {
  building: boolean;
  lastBuild: {
    success: boolean;
    timestamp: string;
    totalDuration: number;
    steps: Array<{
      step: string;
      success: boolean;
      duration: number;
      error?: string;
      diagnostics?: Array<{
        file: string;
        line: number;
        column: number;
        code: number;
        message: string;
        severity: 'error' | 'warning';
      }>;
    }>;
    typeErrors: number;
    bundleErrors: number;
  } | null;
}

export interface DeployResponse {
  success: boolean;
  entityCount: number;
  errors: Array<{ file: string; error: string }>;
  duration: number;
}

export interface DeployManifestResponse {
  files: Record<string, {
    commit: string;
    deployedAt: string;
    bundlePath: string;
  }>;
}

export interface BuildRouteOptions {
  triggerBuild: BuildTriggerFn;
  getBuildStatus: BuildStatusFn;
  triggerDeploy: DeployTriggerFn;
  deployFile?: DeployFileFn;
  undeployFile?: UndeployFileFn;
  getDeployManifest?: GetDeployManifestFn;
}

export function createBuildRoutes(opts: BuildRouteOptions) {
  const app = new Hono();

  // Trigger build (no deploy)
  app.post('/', async (c) => {
    try {
      const result = await opts.triggerBuild();
      return c.json(result);
    } catch (err) {
      return c.json({ error: 'Build failed to start' }, 500);
    }
  });

  // Get build status
  app.get('/status', (c) => {
    return c.json(opts.getBuildStatus());
  });

  // Trigger deploy (separate from build)
  app.post('/deploy', async (c) => {
    try {
      const result = await opts.triggerDeploy();
      return c.json(result);
    } catch (err) {
      return c.json({ error: 'Deploy failed to start' }, 500);
    }
  });

  // Get deploy manifest (all files and their deployed status)
  app.get('/deploy', (c) => {
    if (!opts.getDeployManifest) {
      return c.json({ files: {} });
    }
    return c.json(opts.getDeployManifest());
  });

  // Deploy a specific version of a file
  app.post('/deploy/:path{.+}', async (c) => {
    if (!opts.deployFile) {
      return c.json({ error: 'Per-file deploy not available' }, 501);
    }
    const filePath = c.req.param('path');
    try {
      const body = await c.req.json<{ commit: string }>();
      if (!body.commit || typeof body.commit !== 'string') {
        return c.json({ error: 'Missing commit field' }, 400);
      }
      const result = await opts.deployFile(filePath, body.commit);
      return c.json(result);
    } catch (err) {
      return c.json({ error: 'Deploy failed' }, 500);
    }
  });

  // Undeploy a file
  app.delete('/deploy/:path{.+}', async (c) => {
    if (!opts.undeployFile) {
      return c.json({ error: 'Undeploy not available' }, 501);
    }
    const filePath = c.req.param('path');
    try {
      await opts.undeployFile(filePath);
      return c.json({ success: true });
    } catch (err) {
      return c.json({ error: 'Undeploy failed' }, 500);
    }
  });

  return app;
}

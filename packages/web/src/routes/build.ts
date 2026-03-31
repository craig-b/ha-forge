import { Hono } from 'hono';

export type DeployFileFn = (filename: string, commit: string) => Promise<DeployResponse>;
export type UndeployFileFn = (filename: string) => Promise<void>;
export type GetDeployManifestFn = () => DeployManifestResponse;

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
  deployFile?: DeployFileFn;
  undeployFile?: UndeployFileFn;
  getDeployManifest?: GetDeployManifestFn;
}

export function createBuildRoutes(opts: BuildRouteOptions) {
  const app = new Hono();

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

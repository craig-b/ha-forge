import { Hono } from 'hono';

export type BuildTriggerFn = () => Promise<BuildStatusResponse>;
export type BuildStatusFn = () => BuildStatusResponse;

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
    entityCount: number;
  } | null;
}

export interface BuildRouteOptions {
  triggerBuild: BuildTriggerFn;
  getBuildStatus: BuildStatusFn;
}

export function createBuildRoutes(opts: BuildRouteOptions) {
  const app = new Hono();

  // Trigger build
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

  return app;
}

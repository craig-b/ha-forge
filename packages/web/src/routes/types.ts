import { Hono } from 'hono';
import * as fs from 'node:fs';
import * as path from 'node:path';

export type TypeRegenFn = () => Promise<{ success: boolean; entityCount: number; serviceCount: number; errors: string[] }>;

export interface TypesRouteOptions {
  generatedDir: string;
  regenerateTypes: TypeRegenFn;
}

export function createTypesRoutes(opts: TypesRouteOptions) {
  const app = new Hono();

  // Get type generation status
  app.get('/status', (c) => {
    const metaPath = path.join(opts.generatedDir, 'ha-registry-meta.json');
    if (!fs.existsSync(metaPath)) {
      return c.json({ generated: false, meta: null });
    }

    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
      return c.json({ generated: true, meta });
    } catch {
      return c.json({ generated: false, meta: null });
    }
  });

  // Serve SDK type definitions for Monaco editor
  app.get('/sdk', (c) => {
    try {
      // Find SDK dist directory — resolve from the runtime package location
      const sdkDistPaths = [
        path.resolve('/app/node_modules/@ha-ts-entities/sdk/dist'),
        path.resolve('node_modules/@ha-ts-entities/sdk/dist'),
        // Development: resolve relative to this package
        path.resolve(import.meta.dirname ?? __dirname, '../../sdk/dist'),
      ];

      let sdkDist: string | null = null;
      for (const p of sdkDistPaths) {
        if (fs.existsSync(path.join(p, 'index.d.ts'))) {
          sdkDist = p;
          break;
        }
      }

      if (!sdkDist) {
        return c.json({ error: 'SDK types not found' }, 404);
      }

      // Read all .d.ts files from the SDK dist
      const files: Record<string, string> = {};
      for (const file of fs.readdirSync(sdkDist)) {
        if (file.endsWith('.d.ts')) {
          files[file] = fs.readFileSync(path.join(sdkDist, file), 'utf-8');
        }
      }

      return c.json({ files });
    } catch {
      return c.json({ error: 'Failed to read SDK types' }, 500);
    }
  });

  // Trigger type regeneration
  app.post('/regenerate', async (c) => {
    try {
      const result = await opts.regenerateTypes();
      return c.json(result);
    } catch (err) {
      return c.json({ error: 'Type regeneration failed' }, 500);
    }
  });

  return app;
}

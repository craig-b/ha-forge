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

  // Serve a self-contained declaration for Monaco editor.
  // Includes all SDK types + global function declarations so users
  // get full autocomplete without needing any imports.
  app.get('/sdk', (c) => {
    try {
      const sdkDistPaths = [
        path.resolve('/app/node_modules/@ha-ts-entities/sdk/dist'),
        path.resolve('node_modules/@ha-ts-entities/sdk/dist'),
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

      // Find the types chunk file (contains all interface/type definitions)
      const typesChunk = fs.readdirSync(sdkDist).find(f => f.startsWith('types-') && f.endsWith('.d.ts'));
      if (!typesChunk) {
        return c.json({ error: 'SDK types chunk not found' }, 404);
      }

      // Read the chunk and strip the mangled export line at the end
      let types = fs.readFileSync(path.join(sdkDist, typesChunk), 'utf-8');
      types = types.replace(/^export type \{.*\};\s*$/m, '');

      // Read index.d.ts to get the SensorOptions etc. (function parameter types)
      const indexDts = fs.readFileSync(path.join(sdkDist, 'index.d.ts'), 'utf-8');
      // Extract the interface blocks (SensorOptions, SwitchOptions, etc.)
      const optionInterfaces = indexDts
        .split('\n')
        .filter(line => !line.startsWith('import ') && !line.startsWith('export '))
        .join('\n');

      // Strip the HAClient interface from SDK types — it will be defined by
      // either generated ha-registry.d.ts (with typed overloads) or the untyped
      // fallback appended below. This ensures typed overloads appear before
      // the string fallback in TypeScript's overload resolution order.
      types = types.replace(
        /\/\/ Full client interface[\s\S]*?^interface HAClient extends HAClientBase \{[\s\S]*?^\}/m,
        '',
      );

      // Check if generated registry types exist
      const registryPath = path.join(opts.generatedDir, 'ha-registry.d.ts');
      const hasGeneratedTypes = fs.existsSync(registryPath);

      // When no generated types, append an untyped HAClient fallback
      const untypedFallback = hasGeneratedTypes ? '' : `
interface HAClient extends HAClientBase {
  on(entityOrDomain: string | string[], callback: (event: StateChangedEvent) => void): () => void;
  callService(entity: string, service: string, data?: Record<string, unknown>): Promise<void>;
  getState(entityId: string): Promise<{ state: string; attributes: Record<string, unknown>; last_changed: string; last_updated: string; } | null>;
  reactions(rules: Record<string, ReactionRule>): () => void;
}
`;

      // Build a single self-contained declaration
      const declaration = `// TS Entities SDK types (auto-generated)
${types}
${optionInterfaces}
${untypedFallback}
declare function sensor(options: SensorOptions): SensorDefinition;
declare function defineSwitch(options: SwitchOptions): SwitchDefinition;
declare function light(options: LightOptions): LightDefinition;
declare function cover(options: CoverOptions): CoverDefinition;
declare function climate(options: ClimateOptions): ClimateDefinition;
declare function entityFactory(factory: () => EntityDefinition[] | Promise<EntityDefinition[]>): EntityFactory;
declare const ha: HAClient;
`;

      return c.json({ declaration });
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

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
        path.resolve('/app/node_modules/@ha-forge/sdk/dist'),
        path.resolve('node_modules/@ha-forge/sdk/dist'),
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

      // Check if generated registry types exist
      const registryPath = path.join(opts.generatedDir, 'ha-registry.d.ts');
      const hasGeneratedTypes = fs.existsSync(registryPath);

      // When no generated types, append an untyped HAClient fallback
      const untypedFallback = hasGeneratedTypes ? '' : `
/**
 * Home Assistant client API. Provides entity state subscriptions, service calls,
 * state queries, and declarative reactions.
 *
 * Generate types from your HA instance for typed entity IDs and service parameters.
 */
interface HAClient extends HAClientBase {
  /** List entity IDs registered in Home Assistant, optionally filtered by domain. */
  getEntities(domain?: string): Promise<string[]>;
  /** Subscribe to state changes for an entity, domain, or array of entities. Returns an unsubscribe function. */
  on(entityOrDomain: string | string[], callback: (event: StateChangedEvent) => void): () => void;
  /** Call a Home Assistant service on an entity or domain. */
  callService(entity: string, service: string, data?: Record<string, unknown>): Promise<Record<string, unknown> | null>;
  /** Get the current state of a Home Assistant entity. Returns \`null\` if not found. */
  getState(entityId: string): Promise<{ state: string; attributes: Record<string, unknown>; last_changed: string; last_updated: string; } | null>;
  /** Set up declarative reaction rules. Returns a cleanup function. */
  reactions(rules: Record<string, ReactionRule>): () => void;
}
`;

      // Build a single self-contained declaration
      const declaration = `// HA Forge SDK types (auto-generated)
${types}
${optionInterfaces}
${untypedFallback}
/**
 * Define a read-only sensor entity.
 * @param options - Sensor configuration including id, name, device_class, and lifecycle hooks.
 * @returns A sensor entity definition to export from your script.
 * @example
 * \`\`\`ts
 * export const temp = sensor({
 *   id: 'cpu_temp',
 *   name: 'CPU Temperature',
 *   config: { device_class: 'temperature', unit_of_measurement: '°C' },
 *   init() {
 *     this.poll(async () => {
 *       const resp = await fetch('http://localhost/api/temp');
 *       return (await resp.json()).value;
 *     }, { interval: 30_000 });
 *     return '0';
 *   },
 * });
 * \`\`\`
 */
declare function sensor(options: SensorOptions): SensorDefinition;
/**
 * Define a controllable on/off switch entity.
 * @param options - Switch configuration including id, name, and onCommand handler.
 * @returns A switch entity definition to export from your script.
 * @example
 * \`\`\`ts
 * export const pump = defineSwitch({
 *   id: 'irrigation_pump',
 *   name: 'Irrigation Pump',
 *   onCommand(command) {
 *     // command is 'ON' or 'OFF'
 *     this.update(command === 'ON' ? 'on' : 'off');
 *   },
 * });
 * \`\`\`
 */
declare function defineSwitch(options: SwitchOptions): SwitchDefinition;
/**
 * Define a controllable light entity with optional brightness, color, and effects.
 * @param options - Light configuration including id, name, supported_color_modes, and onCommand handler.
 * @returns A light entity definition to export from your script.
 * @example
 * \`\`\`ts
 * export const lamp = light({
 *   id: 'desk_lamp',
 *   name: 'Desk Lamp',
 *   config: { supported_color_modes: ['brightness', 'color_temp'] },
 *   onCommand(command) {
 *     // command.state is 'ON' or 'OFF', command.brightness is 0-255
 *     this.update({ state: command.state === 'ON' ? 'on' : 'off', brightness: command.brightness });
 *   },
 * });
 * \`\`\`
 */
declare function light(options: LightOptions): LightDefinition;
/**
 * Define a controllable cover entity (blind, garage door, curtain, etc.).
 * @param options - Cover configuration including id, name, and onCommand handler.
 * @returns A cover entity definition to export from your script.
 */
declare function cover(options: CoverOptions): CoverDefinition;
/**
 * Define a climate entity (thermostat, AC unit, heater, etc.).
 * @param options - Climate configuration including id, name, hvac_modes, and onCommand handler.
 * @returns A climate entity definition to export from your script.
 */
declare function climate(options: ClimateOptions): ClimateDefinition;
/**
 * Create an entity factory for dynamic entity generation at runtime.
 * The factory function is called during deploy to produce entity definitions.
 * @param factory - A function that returns an array of entity definitions (sync or async).
 * @returns An entity factory to export from your script.
 */
declare function entityFactory(factory: () => EntityDefinition[] | Promise<EntityDefinition[]>): EntityFactory;
/**
 * Define a device that groups multiple entities with a shared lifecycle.
 * Use \`this.entities.xxx.update()\` inside \`init()\` to publish state for each entity.
 * @param options - Device configuration including id, name, entities map, and lifecycle hooks.
 * @returns A device definition to export from your script.
 * @example
 * \`\`\`ts
 * export const station = device({
 *   id: 'weather_station',
 *   name: 'Weather Station',
 *   entities: {
 *     temperature: sensor({ id: 'ws_temp', name: 'Temperature', config: { device_class: 'temperature', unit_of_measurement: '°C' } }),
 *     humidity: sensor({ id: 'ws_humidity', name: 'Humidity', config: { device_class: 'humidity', unit_of_measurement: '%' } }),
 *   },
 *   init() {
 *     this.poll(async () => {
 *       const data = await (await fetch('https://api.example.com/weather')).json();
 *       this.entities.temperature.update(data.temp);
 *       this.entities.humidity.update(data.humidity);
 *     }, { interval: 60_000 });
 *   },
 * });
 * \`\`\`
 */
declare function device<TEntities extends Record<string, EntityDefinition>>(options: DeviceOptions<TEntities>): DeviceDefinition<TEntities>;
/**
 * Home Assistant client API.
 * Subscribe to entity state changes, call services, query state, list entities, and set up declarative reactions.
 * All entity IDs and service parameters are fully typed when registry types are generated.
 *
 * @example
 * \`\`\`ts
 * // Subscribe to state changes
 * ha.on('binary_sensor.front_door', (event) => {
 *   if (event.new_state === 'on') ha.callService('light.porch', 'turn_on');
 * });
 *
 * // Query current state
 * const state = await ha.getState('sensor.temperature');
 *
 * // List all lights
 * const lights = await ha.getEntities('light');
 * \`\`\`
 */
declare const ha: HAClient;

/** Console output goes to the HA add-on Log tab, not the HA Forge log viewer. Use \`this.log\` or \`ha.log\` for structured logging. */
interface Console {
  /** Outputs to the HA add-on Log tab. Use \`this.log.info()\` or \`ha.log.info()\` for the HA Forge log viewer. */
  log(...args: unknown[]): void;
  /** Outputs to the HA add-on Log tab. Use \`this.log.warn()\` or \`ha.log.warn()\` for the HA Forge log viewer. */
  warn(...args: unknown[]): void;
  /** Outputs to the HA add-on Log tab. Use \`this.log.error()\` or \`ha.log.error()\` for the HA Forge log viewer. */
  error(...args: unknown[]): void;
}
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

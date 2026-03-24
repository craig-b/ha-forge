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

  // Serve the completion registry for Monaco editor custom completions
  app.get('/completion-registry', (c) => {
    const registryPath = path.join(opts.generatedDir, 'ha-completion-registry.json');
    if (!fs.existsSync(registryPath)) {
      return c.json(null, 404);
    }
    try {
      return c.json(JSON.parse(fs.readFileSync(registryPath, 'utf-8')));
    } catch {
      return c.json(null, 500);
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

      // Replace base types with generated typed versions in EntityContext/DeviceContext
      // so users never see untyped `string` where a typed entity ID should be
      types = types.replace(/\bha: StatelessHAApi\b/g, 'ha: HAClient');
      types = types.replace(/\bevents: EventsContext\b/g, 'events: HAEventsContext');

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

      // When no generated types, provide empty HAClient/HAEventsContext stubs.
      // Users must generate types from their HA instance to get typed entity IDs and autocomplete.
      const untypedFallback = hasGeneratedTypes ? '' : `
/**
 * Home Assistant client API. **Click "Regenerate Types" to enable typed entity IDs, services, and autocomplete.**
 *
 * Without generated types, \`this.ha\` methods are unavailable.
 * Generate types from your HA instance to unlock full IntelliSense.
 */
interface HAClient {}

/**
 * Event subscription context. **Click "Regenerate Types" to enable typed entity subscriptions and autocomplete.**
 *
 * Without generated types, \`this.events\` methods are unavailable.
 * Generate types from your HA instance to unlock full IntelliSense.
 */
interface HAEventsContext {}
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
 * Define a computed (derived) sensor entity.
 * State is a pure function of other entities — no \`init()\`, no polling.
 * The runtime auto-subscribes to watched entities and re-evaluates on change.
 * Only publishes when the computed value actually differs.
 * @param options - Computed entity configuration including watch list and compute function.
 * @returns A computed entity definition to export from your script.
 * @example
 * \`\`\`ts
 * export const comfort = computed({
 *   id: 'comfort_index',
 *   name: 'Comfort Index',
 *   watch: ['sensor.temperature', 'sensor.humidity'],
 *   compute: (states) => {
 *     const temp = Number(states['sensor.temperature']?.state);
 *     const humidity = Number(states['sensor.humidity']?.state);
 *     return Math.round(temp + 0.05 * humidity);
 *   },
 *   config: { unit_of_measurement: '°C', device_class: 'temperature' },
 * });
 * \`\`\`
 */
declare function computed(options: ComputedOptions): ComputedDefinition;
/**
 * Create a reactive computed attribute for use inside entity \`attributes\`.
 * The runtime auto-subscribes to watched entities and re-publishes the
 * owning entity's attributes when the derived value changes.
 * @param fn - Pure function that derives the attribute value from watched entity snapshots.
 * @param opts - Watch list and optional debounce.
 * @returns A \`ComputedAttribute\` marker used by the runtime.
 * @example
 * \`\`\`ts
 * export const temp = sensor({
 *   id: 'cpu_temp',
 *   name: 'CPU Temperature',
 *   attributes: {
 *     severity: computed(
 *       (states) => {
 *         const t = Number(states['sensor.cpu_temp']?.state);
 *         return t > 80 ? 'critical' : t > 60 ? 'warning' : 'normal';
 *       },
 *       { watch: ['sensor.cpu_temp'] },
 *     ),
 *   },
 * });
 * \`\`\`
 */
declare function computed(
  fn: (states: Record<string, EntitySnapshot | null>) => unknown,
  opts: ComputedAttributeOptions,
): ComputedAttribute;
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
 * Define a read-only binary (on/off) sensor entity.
 * @param options - Binary sensor configuration including id, name, device_class, and lifecycle hooks.
 * @returns A binary sensor entity definition to export from your script.
 */
declare function binarySensor(options: BinarySensorOptions): BinarySensorDefinition;
/**
 * Define a controllable fan entity with optional speed, oscillation, and direction support.
 * @param options - Fan configuration including id, name, and onCommand handler.
 * @returns A fan entity definition to export from your script.
 */
declare function fan(options: FanOptions): FanDefinition;
/**
 * Define a controllable lock entity.
 * @param options - Lock configuration including id, name, and onCommand handler.
 * @returns A lock entity definition to export from your script.
 */
declare function lock(options: LockOptions): LockDefinition;
/**
 * Define a numeric input entity with min/max bounds.
 * @param options - Number configuration including id, name, and onCommand handler.
 * @returns A number entity definition to export from your script.
 */
declare function number(options: NumberOptions): NumberDefinition;
/**
 * Define a dropdown selection entity.
 * @param options - Select configuration including id, name, options list, and onCommand handler.
 * @returns A select entity definition to export from your script.
 */
declare function select(options: SelectOptions): SelectDefinition;
/**
 * Define a text input entity.
 * @param options - Text configuration including id, name, and onCommand handler.
 * @returns A text entity definition to export from your script.
 */
declare function text(options: TextOptions): TextDefinition;
/**
 * Define a momentary button entity (command only, no state).
 * @param options - Button configuration including id, name, and onPress handler.
 * @returns A button entity definition to export from your script.
 */
declare function button(options: ButtonOptions): ButtonDefinition;
/**
 * Define a siren/alarm entity.
 * @param options - Siren configuration including id, name, and onCommand handler.
 * @returns A siren entity definition to export from your script.
 */
declare function siren(options: SirenOptions): SirenDefinition;
/**
 * Define a humidifier/dehumidifier entity.
 * @param options - Humidifier configuration including id, name, and onCommand handler.
 * @returns A humidifier entity definition to export from your script.
 */
declare function humidifier(options: HumidifierOptions): HumidifierDefinition;
/**
 * Define a controllable valve entity (water valve, gas valve, etc.).
 * @param options - Valve configuration including id, name, and onCommand handler.
 * @returns A valve entity definition to export from your script.
 */
declare function valve(options: ValveOptions): ValveDefinition;
/**
 * Define a water heater entity with temperature and mode control.
 * @param options - Water heater configuration including id, name, modes, and onCommand handler.
 * @returns A water heater entity definition to export from your script.
 */
declare function waterHeater(options: WaterHeaterOptions): WaterHeaterDefinition;
/**
 * Define a robot vacuum entity.
 * @param options - Vacuum configuration including id, name, and onCommand handler.
 * @returns A vacuum entity definition to export from your script.
 */
declare function vacuum(options: VacuumOptions): VacuumDefinition;
/**
 * Define a robotic lawn mower entity.
 * @param options - Lawn mower configuration including id, name, and onCommand handler.
 * @returns A lawn mower entity definition to export from your script.
 */
declare function lawnMower(options: LawnMowerOptions): LawnMowerDefinition;
/**
 * Define a security alarm control panel entity.
 * @param options - Alarm panel configuration including id, name, and onCommand handler.
 * @returns An alarm control panel entity definition to export from your script.
 */
declare function alarmControlPanel(options: AlarmControlPanelOptions): AlarmControlPanelDefinition;
/**
 * Define a notification target entity (write-only).
 * @param options - Notify configuration including id, name, and onNotify handler.
 * @returns A notify entity definition to export from your script.
 */
declare function notify(options: NotifyOptions): NotifyDefinition;
/**
 * Define an update availability indicator entity.
 * @param options - Update configuration including id, name, and optional onInstall handler.
 * @returns An update entity definition to export from your script.
 */
declare function update(options: UpdateOptions): UpdateDefinition;
/**
 * Define a static image entity. State is the image URL.
 * @param options - Image configuration including id, name, and lifecycle hooks.
 * @returns An image entity definition to export from your script.
 */
declare function image(options: ImageOptions): ImageDefinition;
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
 * Define a pure reactive automation with managed lifecycle.
 * Automations subscribe to events and call services but don't publish their own state.
 * Set \`entity: true\` to surface as a binary_sensor in HA (ON = running, OFF = errored).
 * @param options - Automation configuration including id and init/destroy callbacks.
 * @returns An automation definition to export from your script.
 * @example
 * \`\`\`ts
 * export const motionLights = automation({
 *   id: 'motion_lights',
 *   init() {
 *     this.events.stream('binary_sensor.hallway_motion')
 *       .subscribe(async (event) => {
 *         if (event.new_state === 'on') {
 *           await this.ha.callService('light.hallway', 'turn_on');
 *         }
 *       });
 *   },
 * });
 * \`\`\`
 */
declare function automation(options: AutomationOptions): AutomationDefinition;
/**
 * Define a one-shot task surfaced as a button entity in HA.
 * Press the button to trigger \`run()\`. Use \`runOnDeploy: true\` to also execute on deploy.
 * @param options - Task configuration including id, name, and run callback.
 * @returns A task definition to export from your script.
 * @example
 * \`\`\`ts
 * export const notifyAll = task({
 *   id: 'notify_all',
 *   name: 'Notify All Devices',
 *   icon: 'mdi:bullhorn',
 *   run() {
 *     this.ha.callService('notify.all_devices', 'send_message', {
 *       message: 'Hello from HA Forge!',
 *     });
 *   },
 * });
 * \`\`\`
 */
declare function task(options: TaskOptions): TaskDefinition;
/**
 * Define a mode / state machine surfaced as a \`select\` entity in HA.
 * The runtime manages enter/exit transition hooks and optional guards.
 * Other scripts can observe mode changes via \`ha.on('select.<id>', ...)\`.
 * @param options - Mode configuration including states, initial state, and transition hooks.
 * @returns A mode definition to export from your script.
 * @example
 * \`\`\`ts
 * export const houseMode = mode({
 *   id: 'house_mode',
 *   name: 'House Mode',
 *   states: ['home', 'away', 'sleep', 'movie'],
 *   initial: 'home',
 *   transitions: {
 *     away: {
 *       enter: () => {
 *         ha.callService('climate.main', 'set_hvac_mode', { hvac_mode: 'eco' });
 *         ha.callService('light', 'turn_off');
 *       },
 *       exit: () => ha.callService('climate.main', 'set_hvac_mode', { hvac_mode: 'auto' }),
 *       guard(from) { return from !== 'sleep'; },
 *     },
 *     movie: {
 *       enter: () => ha.callService('light.living_room', 'turn_on', { brightness: 30 }),
 *     },
 *   },
 * });
 * \`\`\`
 */
declare function mode<TStates extends string>(options: ModeOptions<TStates>): ModeDefinition<TStates>;
/**
 * Define a schedule entity surfaced as a \`binary_sensor\` in HA.
 * ON during matching cron windows, OFF otherwise.
 * Usable as a dependency in \`computed()\`, \`this.events.stream()\`, etc.
 * @param options - Cron schedule configuration including id, name, and schedule expression.
 * @returns A cron definition to export from your script.
 * @example
 * \`\`\`ts
 * export const schedule = cron({
 *   id: 'work_hours',
 *   name: 'Work Hours',
 *   schedule: '0 9-17 * * 1-5',  // weekdays 9-5
 * });
 * \`\`\`
 */
declare function cron(options: CronOptions): CronDefinition;
/**
 * Define simulation scenarios — groups of signal sources that run together.
 * Scenarios are source-only and never deployed. Use the web editor's scenario
 * picker to switch between them.
 */
declare const simulate: typeof import('@ha-forge/sdk').simulate;
/**
 * Library of pure signal generators for use with \`simulate.scenario()\`.
 * Includes \`signals.numeric()\`, \`signals.binary()\`, \`signals.enum()\`, and \`signals.recorded()\`.
 */
declare const signals: typeof import('@ha-forge/sdk').signals;
/**
 * Global stateless Home Assistant client API.
 * Call services, query state, and list entities. For event subscriptions, use \`this.events\` inside entity callbacks.
 * All entity IDs and service parameters are fully typed when registry types are generated.
 *
 * @example
 * \`\`\`ts
 * // Inside entity init():
 * // Subscribe to state changes (lifecycle-managed)
 * this.events.stream('binary_sensor.front_door')
 *   .subscribe((event) => {
 *     if (event.new_state === 'on') this.ha.callService('light.porch', 'turn_on');
 *   });
 *
 * // Query current state
 * const state = await this.ha.getState('sensor.temperature');
 *
 * // List all lights
 * const lights = await this.ha.getEntities('light');
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

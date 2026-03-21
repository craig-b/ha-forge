import * as fs from 'node:fs';
import * as path from 'node:path';

// ---- HA WebSocket data shapes ----

export interface HAServiceField {
  name?: string;
  description?: string;
  required?: boolean;
  default?: unknown;
  selector?: Record<string, unknown>;
}

export interface HAService {
  name?: string;
  description?: string;
  fields: Record<string, HAServiceField>;
  target?: Record<string, unknown>;
  /** Whether this service returns response data. Set by HA's SupportsResponse enum. */
  response?: { optional: boolean };
}

export interface HAServiceDomain {
  [serviceName: string]: HAService;
}

export interface HAStateObject {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed: string;
  last_updated: string;
}

export interface HAEntityRegistryEntry {
  entity_id: string;
  unique_id: string;
  platform: string;
  device_id?: string;
  area_id?: string;
  name?: string;
  icon?: string;
  disabled_by?: string;
  hidden_by?: string;
  categories?: Record<string, string>;
  labels?: string[];
}

export interface HAAreaRegistryEntry {
  area_id: string;
  name: string;
  aliases?: string[];
  floor_id?: string;
  icon?: string;
  labels?: string[];
  picture?: string;
}

export interface HALabelRegistryEntry {
  label_id: string;
  name: string;
  color?: string;
  description?: string;
  icon?: string;
}

export interface HADeviceRegistryEntry {
  id: string;
  name?: string;
  manufacturer?: string;
  model?: string;
  area_id?: string;
  labels?: string[];
}

// ---- Registry data collected from HA ----

export interface HARegistryData {
  services: Record<string, HAServiceDomain>;
  states: HAStateObject[];
  entities: HAEntityRegistryEntry[];
  devices: HADeviceRegistryEntry[];
  areas: HAAreaRegistryEntry[];
  labels: HALabelRegistryEntry[];
  haVersion: string;
}

// ---- Type generation output ----

export interface TypeGenResult {
  success: boolean;
  entityCount: number;
  serviceCount: number;
  errors: string[];
  duration: number;
}

// ---- Selector to TypeScript type mapping ----

export interface SelectorTypeInfo {
  tsType: string;
  validatorCode: string | null;
}

export function selectorToType(selector: Record<string, unknown>, entityIds?: string[]): SelectorTypeInfo {
  const selectorType = Object.keys(selector)[0];
  if (!selectorType) {
    return { tsType: 'unknown', validatorCode: null };
  }

  const selectorValue = selector[selectorType];

  switch (selectorType) {
    case 'number': {
      const opts = (selectorValue ?? {}) as Record<string, unknown>;
      const min = typeof opts.min === 'number' ? opts.min : undefined;
      const max = typeof opts.max === 'number' ? opts.max : undefined;
      if (min !== undefined && max !== undefined) {
        return {
          tsType: `number`,
          validatorCode: `rangeValidator(${min}, ${max})`,
        };
      }
      return { tsType: 'number', validatorCode: null };
    }

    case 'boolean':
      return { tsType: 'boolean', validatorCode: null };

    case 'text':
      return { tsType: 'string', validatorCode: null };

    case 'select': {
      const opts = (selectorValue ?? {}) as Record<string, unknown>;
      const options = opts.options as Array<string | { value: string; label: string }> | undefined;
      if (options && options.length > 0) {
        const values = options.map((o) =>
          typeof o === 'string' ? o : o.value,
        );
        const tsType = values.map((v) => `'${escapeQuotes(v)}'`).join(' | ');
        const validatorValues = values.map((v) => `'${escapeQuotes(v)}'`).join(', ');
        return {
          tsType,
          validatorCode: `oneOfValidator([${validatorValues}] as const)`,
        };
      }
      return { tsType: 'string', validatorCode: null };
    }

    case 'entity': {
      const opts = (selectorValue ?? {}) as Record<string, unknown>;
      const domain = opts.domain as string | undefined;
      if (domain && entityIds) {
        const matching = entityIds.filter((id) => id.startsWith(`${domain}.`));
        if (matching.length > 0 && matching.length <= 100) {
          const tsType = matching.map((id) => `'${escapeQuotes(id)}'`).join(' | ');
          return { tsType, validatorCode: null };
        }
      }
      return { tsType: 'string', validatorCode: null };
    }

    case 'color_rgb':
      return {
        tsType: '[number, number, number]',
        validatorCode: 'rgbValidator()',
      };

    case 'color_temp': {
      const opts = (selectorValue ?? {}) as Record<string, unknown>;
      const min = typeof opts.min === 'number' ? opts.min : undefined;
      const max = typeof opts.max === 'number' ? opts.max : undefined;
      if (min !== undefined && max !== undefined) {
        return {
          tsType: 'number',
          validatorCode: `rangeValidator(${min}, ${max})`,
        };
      }
      return { tsType: 'number', validatorCode: null };
    }

    case 'time':
      return { tsType: 'string', validatorCode: null };

    case 'time_period':
      return { tsType: 'string', validatorCode: null };

    case 'template':
      return { tsType: 'string', validatorCode: null };

    case 'device':
      return { tsType: 'string', validatorCode: null };

    case 'area':
      return { tsType: 'string', validatorCode: null };

    case 'object':
      return { tsType: 'Record<string, unknown>', validatorCode: null };

    case 'target':
      return {
        tsType: '{ entity_id?: string | string[]; device_id?: string | string[]; area_id?: string | string[] }',
        validatorCode: null,
      };

    case 'addon':
      return { tsType: 'string', validatorCode: null };

    case 'backup_location':
      return { tsType: 'string', validatorCode: null };

    case 'config_entry':
      return { tsType: 'string', validatorCode: null };

    case 'conversation_agent':
      return { tsType: 'string', validatorCode: null };

    case 'date':
      return { tsType: 'string', validatorCode: null };

    case 'datetime':
      return { tsType: 'string', validatorCode: null };

    case 'duration':
      return { tsType: '{ hours?: number; minutes?: number; seconds?: number }', validatorCode: null };

    case 'floor':
      return { tsType: 'string', validatorCode: null };

    case 'icon':
      return { tsType: 'string', validatorCode: null };

    case 'label':
      return { tsType: 'string', validatorCode: null };

    case 'language':
      return { tsType: 'string', validatorCode: null };

    case 'location':
      return { tsType: '{ latitude: number; longitude: number; radius?: number }', validatorCode: null };

    case 'media':
      return { tsType: 'string', validatorCode: null };

    case 'theme':
      return { tsType: 'string', validatorCode: null };

    case 'constant':
      return {
        tsType: typeof selectorValue === 'object' && selectorValue !== null
          ? `'${escapeQuotes(String((selectorValue as Record<string, unknown>).value ?? ''))}'`
          : 'string',
        validatorCode: null,
      };

    case 'action':
    case 'trigger':
    case 'condition':
      return { tsType: 'Record<string, unknown>', validatorCode: null };

    default:
      // Unknown selector — fall back to unknown for forward compatibility
      return { tsType: 'unknown', validatorCode: null };
  }
}

// ---- Type generator ----

export function generateTypes(data: HARegistryData, outputDir: string): TypeGenResult {
  const startTime = Date.now();
  const errors: string[] = [];

  try {
    fs.mkdirSync(outputDir, { recursive: true });
  } catch (err) {
    return {
      success: false,
      entityCount: 0,
      serviceCount: 0,
      errors: [`Failed to create output directory: ${err instanceof Error ? err.message : String(err)}`],
      duration: Date.now() - startTime,
    };
  }

  const entityIds = data.states.map((s) => s.entity_id);

  // Build entity map entries
  const entityMapEntries: string[] = [];
  let serviceCount = 0;

  // Group states by entity
  const stateMap = new Map<string, HAStateObject>();
  for (const state of data.states) {
    stateMap.set(state.entity_id, state);
  }

  // Build services by domain
  const servicesByDomain = new Map<string, Map<string, HAService>>();
  for (const [domain, services] of Object.entries(data.services)) {
    const svcMap = new Map<string, HAService>();
    for (const [name, svc] of Object.entries(services)) {
      svcMap.set(name, svc);
      serviceCount++;
    }
    servicesByDomain.set(domain, svcMap);
  }

  // Collect validators
  const validatorEntries: string[] = [];

  for (const entityId of entityIds) {
    const state = stateMap.get(entityId);
    if (!state) continue;

    const domain = entityId.split('.')[0];

    // Determine state type
    const stateType = inferStateType(domain, state);

    // Determine attributes type
    const attrsType = inferAttributesType(state.attributes);

    // Determine services type for this entity's domain
    const domainServices = servicesByDomain.get(domain);
    const servicesType = domainServices
      ? generateServicesType(domain, domainServices, entityIds, validatorEntries, entityId)
      : '{}';

    entityMapEntries.push(
      `  '${escapeQuotes(entityId)}': {\n` +
      `    domain: '${escapeQuotes(domain)}';\n` +
      `    state: ${stateType};\n` +
      `    attributes: ${attrsType};\n` +
      `    services: ${servicesType};\n` +
      `  };`,
    );
  }

  // ---- Build typed HAClient overloads ----
  const onOverloads: string[] = [];
  const domainOnOverloads: string[] = [];
  const getStateOverloads: string[] = [];
  const callServiceOverloads: string[] = [];
  const domainCallServiceOverloads: string[] = [];

  // Collect unique domains that have entities
  const domainsWithEntities = new Set<string>();

  for (const entityId of entityIds) {
    const state = stateMap.get(entityId);
    if (!state) continue;

    const domain = entityId.split('.')[0];
    const stateType = inferStateType(domain, state);
    const attrsType = inferAttributesType(state.attributes);
    const escapedId = escapeQuotes(entityId);

    domainsWithEntities.add(domain);

    // on() overload — includes entity_id literal as third TypedStateChangedEvent param
    onOverloads.push(
      `  on(entity: '${escapedId}', callback?: (event: TypedStateChangedEvent<${stateType}, ${attrsType}, '${escapedId}'>) => void): EventStream<TypedStateChangedEvent<${stateType}, ${attrsType}, '${escapedId}'>>;`,
    );

    // getState() overload
    getStateOverloads.push(
      `  getState(entityId: '${escapedId}'): Promise<{ state: ${stateType}; attributes: ${attrsType}; last_changed: string; last_updated: string; } | null>;`,
    );

    // callService() overload — one generic overload per entity, mapped data type via HAEntityMap
    const domainServices = servicesByDomain.get(domain);
    if (domainServices && domainServices.size > 0) {
      callServiceOverloads.push(
        `  callService<S extends keyof HAEntityMap['${escapedId}']['services']>(entity: '${escapedId}', service: S, data?: HAEntityMap['${escapedId}']['services'][S]['data']): Promise<HAEntityMap['${escapedId}']['services'][S]['responds'] extends true ? Record<string, unknown> : null>;`,
      );
    }
  }

  // Build domain-level on() overloads — state is typed per domain, attributes are Record<string, unknown>
  // entity_id narrows to EntitiesInDomain<D> for discriminated unions
  for (const domain of domainsWithEntities) {
    const escapedDomain = escapeQuotes(domain);
    // Use the domain's shared state type (pick representative entity)
    const repEntity = entityIds.find((id) => id.startsWith(`${domain}.`));
    const repState = repEntity ? stateMap.get(repEntity) : undefined;
    const domainStateType = repState ? inferStateType(domain, repState) : 'string';

    domainOnOverloads.push(
      `  on(domain: '${escapedDomain}', callback?: (event: TypedStateChangedEvent<${domainStateType}, Record<string, unknown>, EntitiesInDomain<'${escapedDomain}'>>) => void): EventStream<TypedStateChangedEvent<${domainStateType}, Record<string, unknown>, EntitiesInDomain<'${escapedDomain}'>>>;`,
    );
  }

  // Build domain-level callService() overloads — target all entities in a domain
  for (const domain of domainsWithEntities) {
    const domainServices = servicesByDomain.get(domain);
    if (domainServices && domainServices.size > 0) {
      const escapedDomain = escapeQuotes(domain);
      domainCallServiceOverloads.push(
        `  callService<S extends keyof HAEntityMap[\`${escapedDomain}.\${string}\` & HAEntityId]['services']>(entity: '${escapedDomain}', service: S, data?: HAEntityMap[\`${escapedDomain}.\${string}\` & HAEntityId]['services'][S]['data']): Promise<HAEntityMap[\`${escapedDomain}.\${string}\` & HAEntityId]['services'][S]['responds'] extends true ? Record<string, unknown> : null>;`,
      );
    }
  }

  // ---- Generate ha-registry.d.ts (ambient — no import/export) ----
  const dtsContent = [
    `// Auto-generated by ha-forge type generator`,
    `// Generated: ${new Date().toISOString()}`,
    `// HA Version: ${data.haVersion}`,
    `// Entity count: ${entityIds.length}`,
    ``,
    `/**`,
    ` * Map of every HA entity ID to its state type, attributes, domain, and available services.`,
    ` * Auto-generated from the live Home Assistant registry.`,
    ` */`,
    `type HAEntityMap = {`,
    ...entityMapEntries,
    `};`,
    ``,
    `/** Union of all known HA entity IDs (e.g. \`'light.kitchen' | 'sensor.temperature' | ...\`). */`,
    `type HAEntityId = keyof HAEntityMap;`,
    ``,
    `/** Union of all HA domains that have entities (e.g. \`'light' | 'sensor' | 'switch' | ...\`). */`,
    `type HADomain = HAEntityMap[HAEntityId]['domain'];`,
    ``,
    `/** Extract all entity IDs belonging to a specific domain. */`,
    `type EntitiesInDomain<D extends HADomain> = {`,
    `  [K in HAEntityId]: HAEntityMap[K]['domain'] extends D ? K : never;`,
    `}[HAEntityId];`,
    ``,
    `/** Typed entity snapshot with per-entity state and attributes. */`,
    `type TypedEntitySnapshot<E extends HAEntityId> = {`,
    `  state: HAEntityMap[E]['state'];`,
    `  attributes: HAEntityMap[E]['attributes'];`,
    `};`,
    ``,
    `/**`,
    ` * Typed stateless Home Assistant client with per-entity overloads for autocomplete.`,
    ` * Access via \`this.ha\` in entity/device callbacks. Safe to pass to utility functions.`,
    ` * Generated from the live HA registry — entity IDs, services, and state types`,
    ` * are all derived from your actual Home Assistant instance.`,
    ` */`,
    `interface HAClient {`,
    `  /**`,
    `   * List entity IDs registered in Home Assistant, optionally filtered by domain.`,
    `   * When a domain is specified, returns a typed union of entity IDs in that domain.`,
    `   * @param domain - Domain to filter by (e.g. \`'light'\`, \`'sensor'\`).`,
    `   * @returns Array of entity ID strings, typed per domain.`,
    `   */`,
    `  getEntities<D extends HADomain>(domain: D): Promise<EntitiesInDomain<D>[]>;`,
    `  getEntities(domain?: string): Promise<HAEntityId[]>;`,
    ``,
    `  // --- Per-entity callService() overloads: typed service data per entity ---`,
    ...callServiceOverloads,
    ``,
    `  // --- Per-domain callService() overloads: call a service on all entities in a domain ---`,
    ...domainCallServiceOverloads,
    ``,
    `  // --- Per-entity getState() overloads: typed state and attributes per entity ---`,
    ...getStateOverloads,
    ``,
    `  /**`,
    `   * Fire a custom event on the HA event bus.`,
    `   * @param eventType - Event type name (e.g. \`'my_custom_event'\`).`,
    `   * @param eventData - Optional data payload attached to the event.`,
    `   */`,
    `  fireEvent(eventType: string, eventData?: Record<string, unknown>): Promise<void>;`,
    `  /**`,
    `   * Get the friendly name of a Home Assistant entity.`,
    `   * @param entityId - The entity ID (e.g. \`'light.kitchen'\`).`,
    `   * @returns The friendly name string, or the entity ID if unavailable.`,
    `   */`,
    `  friendlyName(entityId: HAEntityId): string;`,
    `}`,
    ``,
    `/**`,
    ` * Typed event subscription context with per-entity overloads for autocomplete.`,
    ` * Access via \`this.events\` in entity/device callbacks. Subscriptions are`,
    ` * automatically cleaned up when the owning entity/device is torn down.`,
    ` */`,
    `interface HAEventsContext {`,
    `  // --- Per-entity on() overloads: subscribe to a specific entity's state changes ---`,
    ...onOverloads,
    ``,
    `  // --- Per-domain on() overloads: subscribe to all entities in a domain ---`,
    ...domainOnOverloads,
    ``,
    `  /**`,
    `   * Subscribe to state changes for multiple entities with typed events.`,
    `   * @param entities - Array of entity IDs to monitor.`,
    `   * @param callback - Called with a typed event each time any listed entity changes.`,
    `   * @returns Unsubscribe function.`,
    `   */`,
    `  on<E extends HAEntityId>(entities: E[], callback?: (event: TypedStateChangedEvent<HAEntityMap[E]['state'], HAEntityMap[E]['attributes'], E>) => void): EventStream<TypedStateChangedEvent<HAEntityMap[E]['state'], HAEntityMap[E]['attributes'], E>>;`,
    ``,
    `  /**`,
    `   * Set up typed declarative reaction rules. Entity IDs autocomplete and the \`to\` field`,
    `   * is typed per entity (e.g. \`'on' | 'off'\` for lights).`,
    `   * @param rules - Map of entity IDs to reaction rules.`,
    `   * @returns Cleanup function that removes all listeners and cancels pending timers.`,
    `   */`,
    `  reactions<K extends HAEntityId>(rules: { [E in K]: {`,
    `    /** Fire action when the entity transitions to this state value. */`,
    `    to?: HAEntityMap[E]['state'];`,
    `    /** Custom condition — return \`true\` to trigger the action. */`,
    `    when?: (event: TypedStateChangedEvent<HAEntityMap[E]['state'], HAEntityMap[E]['attributes'], E>) => boolean;`,
    `    /** Action to execute when the condition is met. */`,
    `    do: () => void | Promise<void>;`,
    `    /** Delay (ms) before executing. Cancelled if state changes again. */`,
    `    after?: number;`,
    `  } }): () => void;`,
    ``,
    `  /** Subscribe to multiple entities and receive a combined state snapshot on every change. */`,
    `  combine<E extends HAEntityId>(entities: E[], callback: (states: { [K in E]: TypedEntitySnapshot<K> | null }) => void): () => void;`,
    ``,
    `  /** Subscribe to state changes with typed context entity snapshots. */`,
    `  withState<C extends HAEntityId>(entityOrDomain: HAEntityId | HADomain, context: C[], callback: (event: StateChangedEvent, states: { [K in C]: TypedEntitySnapshot<K> }) => void): EventStream;`,
    `  withState<C extends HAEntityId>(entities: HAEntityId[], context: C[], callback: (event: StateChangedEvent, states: { [K in C]: TypedEntitySnapshot<K> }) => void): EventStream;`,
    ``,
    `  /** Set up watchdog timers with typed entity IDs. */`,
    `  watchdog<K extends HAEntityId>(rules: { [E in K]: {`,
    `    within: number;`,
    `    expect?: 'change' | { to: HAEntityMap[E]['state'] } | ((event: TypedStateChangedEvent<HAEntityMap[E]['state'], HAEntityMap[E]['attributes'], E>) => boolean);`,
    `    else: () => void | Promise<void>;`,
    `  } }): () => void;`,
    ``,
    `  /** Set up a periodic invariant check. Fires violated() when condition() returns false. */`,
    `  invariant(options: InvariantOptions): () => void;`,
    ``,
    `  /** Detect an ordered sequence of state changes with typed entity IDs. */`,
    `  sequence(options: { name?: string; steps: Array<{ entity: HAEntityId; to: HAEntityMap[HAEntityId]['state'] | '*'; within?: number; negate?: boolean }>; do: () => void | Promise<void> }): () => void;`,
    `}`,
    ``,
    `/** Typed computed entity — watch list constrained to known HA entity IDs. */`,
    `declare function computed<TWatch extends HAEntityId>(options: ComputedOptions<TWatch>): ComputedDefinition<TWatch>;`,
    `/** Typed computed attribute — watch list constrained to known HA entity IDs. */`,
    `declare function computed<TWatch extends HAEntityId>(fn: (states: { [K in TWatch]: TypedEntitySnapshot<TWatch> | null }) => unknown, opts: ComputedAttributeOptions<TWatch>): ComputedAttribute<TWatch>;`,
    ``,
  ].join('\n');

  // ---- Generate ha-validators.ts ----
  const validatorsContent = [
    `// Auto-generated by ha-forge type generator`,
    `// Generated: ${new Date().toISOString()}`,
    ``,
    `import { rangeValidator, oneOfValidator, rgbValidator } from '@ha-forge/sdk/validate';`,
    ``,
    `export const validators: Record<string, Record<string, (value: unknown) => unknown>> = {`,
    ...deduplicateValidators(validatorEntries),
    `};`,
    ``,
  ].join('\n');

  // ---- Generate ha-registry-meta.json ----
  const meta = {
    generatedAt: new Date().toISOString(),
    haVersion: data.haVersion,
    entityCount: entityIds.length,
    serviceCount,
    domainCount: servicesByDomain.size,
    areaCount: data.areas.length,
    deviceCount: data.devices.length,
    labelCount: data.labels.length,
  };

  // Write files
  try {
    fs.writeFileSync(path.join(outputDir, 'ha-registry.d.ts'), dtsContent, 'utf-8');
    fs.writeFileSync(path.join(outputDir, 'ha-validators.ts'), validatorsContent, 'utf-8');
    fs.writeFileSync(path.join(outputDir, 'ha-registry-meta.json'), JSON.stringify(meta, null, 2), 'utf-8');
  } catch (err) {
    errors.push(`Failed to write output files: ${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    success: errors.length === 0,
    entityCount: entityIds.length,
    serviceCount,
    errors,
    duration: Date.now() - startTime,
  };
}

// ---- Helper functions ----

function inferStateType(domain: string, state: HAStateObject): string {
  // Known binary domains
  const binaryDomains = [
    'light', 'switch', 'fan', 'lock', 'binary_sensor',
    'input_boolean', 'automation', 'script', 'siren', 'humidifier',
    'valve', 'vacuum', 'lawn_mower', 'water_heater',
  ];

  if (binaryDomains.includes(domain)) {
    return `'on' | 'off'`;
  }

  // input_select — use options attribute
  if (domain === 'input_select') {
    const options = state.attributes?.options;
    if (Array.isArray(options) && options.length > 0) {
      return options.map((o) => `'${escapeQuotes(String(o))}'`).join(' | ');
    }
  }

  // Climate — hvac modes
  if (domain === 'climate') {
    return `'off' | 'heat' | 'cool' | 'heat_cool' | 'auto' | 'dry' | 'fan_only'`;
  }

  // Cover
  if (domain === 'cover') {
    return `'open' | 'opening' | 'closed' | 'closing' | 'stopped'`;
  }

  // Alarm control panel
  if (domain === 'alarm_control_panel') {
    return `'disarmed' | 'armed_home' | 'armed_away' | 'armed_night' | 'armed_custom_bypass' | 'pending' | 'triggered' | 'arming' | 'disarming'`;
  }

  // Default: string
  return 'string';
}

function inferAttributesType(attributes: Record<string, unknown>): string {
  if (!attributes || Object.keys(attributes).length === 0) {
    return 'Record<string, unknown>';
  }

  const fields: string[] = [];
  for (const [key, value] of Object.entries(attributes)) {
    const tsType = inferValueType(value);
    fields.push(`    ${safeKey(key)}: ${tsType};`);
  }

  return `{\n${fields.join('\n')}\n  }`;
}

function inferValueType(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'unknown';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'string') return 'string';
  if (Array.isArray(value)) {
    if (value.length === 0) return 'never[]';
    const elemType = inferValueType(value[0]);
    return `${elemType}[]`;
  }
  if (typeof value === 'object') return 'Record<string, unknown>';
  return 'unknown';
}

/** Generic script services that apply to all script entities. */
const GENERIC_SCRIPT_SERVICES = new Set(['reload', 'turn_on', 'turn_off', 'toggle']);

function generateServicesType(
  domain: string,
  services: Map<string, HAService>,
  entityIds: string[],
  validatorEntries: string[],
  entityId?: string,
): string {
  const svcFields: string[] = [];

  // For the script domain, each entity only gets generic services + its own
  // object_id service (e.g. script.announce → 'announce')
  const objectId = entityId ? entityId.split('.')[1] : undefined;

  for (const [serviceName, service] of services) {
    if (domain === 'script' && objectId) {
      if (!GENERIC_SCRIPT_SERVICES.has(serviceName) && serviceName !== objectId) {
        continue;
      }
    }
    const fields: string[] = [];
    const validatorFields: string[] = [];

    for (const [fieldName, field] of Object.entries(service.fields)) {
      const fieldDoc = field.description ? `      /** ${escapeQuotes(field.description)} */\n` : '';
      if (!field.selector) {
        fields.push(`${fieldDoc}      ${safeKey(fieldName)}?: unknown;`);
        continue;
      }

      const { tsType, validatorCode } = selectorToType(field.selector, entityIds);
      const optional = field.required ? '' : '?';
      fields.push(`${fieldDoc}      ${safeKey(fieldName)}${optional}: ${tsType};`);

      if (validatorCode) {
        validatorFields.push(`    ${safeKey(fieldName)}: ${validatorCode},`);
      }
    }

    const fieldsStr = fields.length > 0
      ? `{\n${fields.join('\n')}\n    }`
      : '{}';
    const hasResponse = service.response ? 'true' : 'false';
    svcFields.push(`      ${safeKey(serviceName)}: { data: ${fieldsStr}; responds: ${hasResponse} };`);

    // Add validator entry for this service
    if (validatorFields.length > 0) {
      const key = `${domain}.${serviceName}`;
      validatorEntries.push(
        `  '${escapeQuotes(key)}': {\n${validatorFields.join('\n')}\n  },`,
      );
    }
  }

  if (svcFields.length === 0) return '{}';

  return `{\n${svcFields.join('\n')}\n    }`;
}

function deduplicateValidators(entries: string[]): string[] {
  // Remove exact duplicates (same domain.service can appear from multiple entities)
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of entries) {
    if (!seen.has(entry)) {
      seen.add(entry);
      result.push(entry);
    }
  }
  return result;
}

function escapeQuotes(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function safeKey(key: string): string {
  // If key is a valid JS identifier, use as-is; otherwise quote it
  if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key)) {
    return key;
  }
  return `'${escapeQuotes(key)}'`;
}

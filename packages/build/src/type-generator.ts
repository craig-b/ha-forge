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
      ? generateServicesType(domain, domainServices, entityIds, validatorEntries)
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
  const getStateOverloads: string[] = [];
  const callServiceOverloads: string[] = [];

  const typedEntityIds = entityIds;

  for (const entityId of typedEntityIds) {
    const state = stateMap.get(entityId);
    if (!state) continue;

    const domain = entityId.split('.')[0];
    const stateType = inferStateType(domain, state);
    const attrsType = inferAttributesType(state.attributes);
    const escapedId = escapeQuotes(entityId);

    // on() overload
    onOverloads.push(
      `  on(entity: '${escapedId}', callback: (event: TypedStateChangedEvent<${stateType}, ${attrsType}>) => void): () => void;`,
    );

    // getState() overload
    getStateOverloads.push(
      `  getState(entityId: '${escapedId}'): Promise<{ state: ${stateType}; attributes: ${attrsType}; last_changed: string; last_updated: string; } | null>;`,
    );

    // callService() overloads — one per service for this entity's domain
    const domainServices = servicesByDomain.get(domain);
    if (domainServices) {
      for (const [serviceName, service] of domainServices) {
        const fields: string[] = [];
        for (const [fieldName, field] of Object.entries(service.fields)) {
          if (!field.selector) {
            fields.push(`${safeKey(fieldName)}?: unknown`);
            continue;
          }
          const { tsType } = selectorToType(field.selector, entityIds);
          const optional = field.required ? '' : '?';
          fields.push(`${safeKey(fieldName)}${optional}: ${tsType}`);
        }
        const dataType = fields.length > 0
          ? `{ ${fields.join('; ')}; }`
          : 'Record<string, never>';
        callServiceOverloads.push(
          `  callService(entity: '${escapedId}', service: '${escapeQuotes(serviceName)}', data?: ${dataType}): Promise<void>;`,
        );
      }
    }
  }

  // Deduplicate callService overloads (same domain entities share identical service signatures)
  const seenCallService = new Set<string>();
  const dedupedCallServiceOverloads = callServiceOverloads.filter((line) => {
    if (seenCallService.has(line)) return false;
    seenCallService.add(line);
    return true;
  });

  // ---- Generate ha-registry.d.ts (ambient — no import/export) ----
  const dtsContent = [
    `// Auto-generated by ts-entities type generator`,
    `// Generated: ${new Date().toISOString()}`,
    `// HA Version: ${data.haVersion}`,
    `// Entity count: ${entityIds.length}`,
    ``,
    `type HAEntityMap = {`,
    ...entityMapEntries,
    `};`,
    ``,
    `type HAEntityId = keyof HAEntityMap;`,
    ``,
    `type HADomain = HAEntityMap[HAEntityId]['domain'];`,
    ``,
    `type EntitiesInDomain<D extends HADomain> = {`,
    `  [K in HAEntityId]: HAEntityMap[K]['domain'] extends D ? K : never;`,
    `}[HAEntityId];`,
    ``,
    `// Typed HAClient with per-entity overloads.`,
    `// String fallbacks appear LAST so TypeScript resolves typed overloads first.`,
    `interface HAClient extends HAClientBase {`,
    `  // --- Typed on() overloads ---`,
    ...onOverloads,
    ``,
    `  // --- String fallback on() (must be last) ---`,
    `  on(entityOrDomain: string | string[], callback: (event: StateChangedEvent) => void): () => void;`,
    ``,
    `  // --- Typed callService() overloads ---`,
    ...dedupedCallServiceOverloads,
    ``,
    `  // --- String fallback callService() (must be last) ---`,
    `  callService(entity: string, service: string, data?: Record<string, unknown>): Promise<void>;`,
    ``,
    `  // --- Typed getState() overloads ---`,
    ...getStateOverloads,
    ``,
    `  // --- String fallback getState() (must be last) ---`,
    `  getState(entityId: string): Promise<{ state: string; attributes: Record<string, unknown>; last_changed: string; last_updated: string; } | null>;`,
    `}`,
    ``,
  ].join('\n');

  // ---- Generate ha-validators.ts ----
  const validatorsContent = [
    `// Auto-generated by ts-entities type generator`,
    `// Generated: ${new Date().toISOString()}`,
    ``,
    `import { rangeValidator, oneOfValidator, rgbValidator } from '@ha-ts-entities/sdk/validate';`,
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
  if (value === null || value === undefined) return 'unknown';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'string') return 'string';
  if (Array.isArray(value)) {
    if (value.length === 0) return 'unknown[]';
    const elemType = inferValueType(value[0]);
    return `${elemType}[]`;
  }
  if (typeof value === 'object') return 'Record<string, unknown>';
  return 'unknown';
}

function generateServicesType(
  domain: string,
  services: Map<string, HAService>,
  entityIds: string[],
  validatorEntries: string[],
): string {
  const svcFields: string[] = [];

  for (const [serviceName, service] of services) {
    const fields: string[] = [];
    const validatorFields: string[] = [];

    for (const [fieldName, field] of Object.entries(service.fields)) {
      if (!field.selector) {
        fields.push(`      ${safeKey(fieldName)}?: unknown;`);
        continue;
      }

      const { tsType, validatorCode } = selectorToType(field.selector, entityIds);
      const optional = field.required ? '' : '?';
      fields.push(`      ${safeKey(fieldName)}${optional}: ${tsType};`);

      if (validatorCode) {
        validatorFields.push(`    ${safeKey(fieldName)}: ${validatorCode},`);
      }
    }

    const fieldsStr = fields.length > 0
      ? `{\n${fields.join('\n')}\n    }`
      : '{}';
    svcFields.push(`      ${safeKey(serviceName)}: ${fieldsStr};`);

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

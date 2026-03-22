/**
 * AST-based code analyzers for Monaco editor.
 *
 * Uses TypeScript's compiler API (ts.createSourceFile) to parse source
 * files and walk the AST for structural analysis that regex can't express:
 * factory call validation, scope analysis, entity ID extraction, etc.
 *
 * Designed to coexist with the regex analyzers in analyzers.ts — each
 * system uses a separate marker owner so diagnostics don't interfere.
 */

import type { AnalyzerDiagnostic } from './analyzers.js';
import { FACTORY_NAMES } from './analyzers.js';

// TypeScript compiler API — loaded lazily from Monaco's CDN
let ts: typeof import('typescript') | null = null;

/** Called once after Monaco loads to provide the TypeScript API. */
export function setTypeScriptApi(tsApi: typeof import('typescript')) {
  ts = tsApi;
}

/** Whether the TypeScript API has been loaded. */
export function isReady(): boolean {
  return ts !== null;
}

// Behavior wrapper names that pass through to an inner factory call
const WRAPPER_NAMES = new Set([
  'debounced', 'filtered', 'sampled', 'buffered',
]);

interface EntityInfo {
  id: string;
  line: number;
  startCol: number;
  endCol: number;
}

export interface AstAnalysisResult {
  diagnostics: AnalyzerDiagnostic[];
  entities: EntityInfo[];
}

/**
 * Run all AST-based analyzers on a source file.
 * Returns diagnostics and extracted entity info (for cross-file analysis).
 */
export function analyzeWithAst(sourceText: string, fileName = 'file.ts'): AstAnalysisResult {
  if (!ts) return { diagnostics: [], entities: [] };

  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, /* setParentNodes */ true);
  const diagnostics: AnalyzerDiagnostic[] = [];
  const entities: EntityInfo[] = [];

  visit(sf);
  checkDuplicateIds(entities, diagnostics);
  checkUnexportedEntities(sf, diagnostics);
  checkDeviceRefactor(sf, diagnostics, fileName);
  return { diagnostics, entities };

  function visit(node: import('typescript').Node) {
    if (ts!.isCallExpression(node)) {
      checkFactoryCall(node, sf, diagnostics, entities);
      checkAwaitOnFactory(node, sf, diagnostics);
      checkCronExpression(node, sf, diagnostics);
      checkSensorConfig(node, sf, diagnostics);
    }

    if (ts!.isPropertyAccessExpression(node) &&
        node.expression.kind === ts!.SyntaxKind.ThisKeyword) {
      const methodName = node.name.text;
      if (methodName === 'poll' || methodName === 'setTimeout' || methodName === 'setInterval') {
        checkThisMethodScope(node, sf, diagnostics, methodName);
      }
    }

    // Bare setTimeout/setInterval (not this.setTimeout)
    if (ts!.isCallExpression(node) && ts!.isIdentifier(node.expression)) {
      const name = node.expression.text;
      if (name === 'setTimeout' || name === 'setInterval') {
        checkBareTimer(node, sf, diagnostics, name);
      }
    }

    ts!.forEachChild(node, visit);
  }
}

// ---- Factory call validation ----

function getCalledName(node: import('typescript').CallExpression): string | null {
  if (!ts) return null;
  if (ts.isIdentifier(node.expression)) return node.expression.text;
  if (ts.isPropertyAccessExpression(node.expression)) return node.expression.name.text;
  return null;
}

/** Unwrap behavior wrappers to find the innermost factory call. */
function findFactoryCall(node: import('typescript').CallExpression): import('typescript').CallExpression | null {
  if (!ts) return null;
  const name = getCalledName(node);
  if (name && FACTORY_NAMES.includes(name)) return node;
  if (name && WRAPPER_NAMES.has(name) && node.arguments.length > 0) {
    const inner = node.arguments[0];
    if (ts.isCallExpression(inner)) return findFactoryCall(inner);
  }
  return null;
}

function checkFactoryCall(
  node: import('typescript').CallExpression,
  sf: import('typescript').SourceFile,
  diagnostics: AnalyzerDiagnostic[],
  entities: EntityInfo[],
) {
  if (!ts) return;
  const name = getCalledName(node);
  if (!name || !FACTORY_NAMES.includes(name)) return;

  // computed() has different required fields (watch, compute)
  if (name === 'computed') {
    checkComputedCall(node, sf, diagnostics, entities);
    return;
  }
  // automation, task, cron, mode don't require 'name'
  const requiresName = !['automation', 'task', 'cron'].includes(name);

  const arg = node.arguments[0];
  if (!arg || !ts.isObjectLiteralExpression(arg)) return;

  const props = new Map<string, import('typescript').Node>();
  for (const prop of arg.properties) {
    if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
      props.set(prop.name.text, prop.initializer);
    } else if (ts.isMethodDeclaration(prop) && prop.name && ts.isIdentifier(prop.name)) {
      props.set(prop.name.text, prop);
    } else if (ts.isShorthandPropertyAssignment(prop)) {
      props.set(prop.name.text, prop);
    }
  }

  if (!props.has('id')) {
    diagnostics.push(markerAt(arg, sf, `${name}() missing required 'id' property`, 'error'));
  }
  if (requiresName && !props.has('name')) {
    diagnostics.push(markerAt(arg, sf, `${name}() missing required 'name' property`, 'error'));
  }

  // Validate entity ID
  const idNode = props.get('id');
  if (idNode && ts.isStringLiteral(idNode)) {
    const id = idNode.text;

    if (id === '') {
      diagnostics.push(markerAt(idNode, sf, `${name}() id must not be empty`, 'error'));
    } else {
      // Extract for cross-file duplicate checking
      const { line } = sf.getLineAndCharacterOfPosition(idNode.getStart(sf));
      const start = idNode.getStart(sf) - sf.getLineStarts()[line];
      entities.push({
        id,
        line: line + 1,
        startCol: start + 1,
        endCol: start + 1 + idNode.getWidth(sf),
      });

      // snake_case validation: lowercase letters, digits, underscores
      if (!/^[a-z][a-z0-9_]*$/.test(id)) {
        const suggested = toSnakeCase(id);
        const hint = suggested && suggested !== id ? ` (suggested: '${suggested}')` : '';
        diagnostics.push(markerAt(idNode, sf,
          `Entity ID '${id}' should be snake_case${hint}`,
          'warning',
        ));
      }

      // Domain mismatch check
      checkIdDomainMismatch(name, idNode, sf, diagnostics);
    }
  }

  // Validate entity name
  const nameNode = props.get('name');
  if (nameNode && ts.isStringLiteral(nameNode) && nameNode.text === '') {
    diagnostics.push(markerAt(nameNode, sf, `${name}() name must not be empty`, 'warning'));
  }

  // Check for empty init()
  const initNode = props.get('init');
  if (initNode && (ts.isMethodDeclaration(initNode) || ts.isFunctionExpression(initNode) || ts.isArrowFunction(initNode))) {
    const body = 'body' in initNode ? initNode.body : undefined;
    if (body && ts.isBlock(body) && body.statements.length === 0) {
      diagnostics.push(markerAt(initNode, sf, `Empty init() — did you forget to set up state updates?`, 'info'));
    }

    // Suggest computed() for sensors that only watch state and update
    if (name === 'sensor' && body && ts.isBlock(body)) {
      checkSuggestComputed(body, initNode, sf, diagnostics);
    }
  }
}

// ---- Suggest computed() ----

/**
 * Check if a sensor's init() only subscribes to state changes and calls this.update —
 * this pattern is better expressed as computed().
 */
function checkSuggestComputed(
  body: import('typescript').Block,
  initNode: import('typescript').Node,
  sf: import('typescript').SourceFile,
  diagnostics: AnalyzerDiagnostic[],
) {
  if (!ts || body.statements.length === 0) return;

  let hasEventsOn = false;
  let hasUpdate = false;
  let hasOtherLogic = false;

  function walkInit(node: import('typescript').Node) {
    if (!ts || hasOtherLogic) return;

    if (ts.isPropertyAccessExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ThisKeyword) {
      const name = node.name.text;
      if (name === 'update' || name === 'attr') {
        hasUpdate = true;
      } else if (name === 'events') {
        // this.events — fine, check for .on() usage
      } else if (name === 'poll' || name === 'setTimeout' || name === 'setInterval' ||
                 name === 'ha' || name === 'mqtt' || name === 'log') {
        hasOtherLogic = true;
      }
    }

    // Check for this.events.on() pattern
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const prop = node.expression;
      if (prop.name.text === 'on' && ts.isPropertyAccessExpression(prop.expression) &&
          prop.expression.name.text === 'events' &&
          prop.expression.expression.kind === ts.SyntaxKind.ThisKeyword) {
        hasEventsOn = true;
      }
    }

    ts.forEachChild(node, walkInit);
  }

  walkInit(body);

  if (hasEventsOn && hasUpdate && !hasOtherLogic) {
    diagnostics.push(markerAt(initNode, sf,
      `This sensor only watches state and calls this.update() — consider using computed() instead`,
      'info',
    ));
  }
}

// ---- computed() validation ----

function checkComputedCall(
  node: import('typescript').CallExpression,
  sf: import('typescript').SourceFile,
  diagnostics: AnalyzerDiagnostic[],
  entities: EntityInfo[],
) {
  if (!ts) return;
  const arg = node.arguments[0];
  if (!arg || !ts.isObjectLiteralExpression(arg)) return;

  const props = new Set<string>();
  for (const prop of arg.properties) {
    if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
      props.add(prop.name.text);
    } else if (ts.isMethodDeclaration(prop) && prop.name && ts.isIdentifier(prop.name)) {
      props.add(prop.name.text);
    } else if (ts.isShorthandPropertyAssignment(prop)) {
      props.add(prop.name.text);
    }
  }

  if (!props.has('id')) {
    diagnostics.push(markerAt(arg, sf, `computed() missing required 'id' property`, 'error'));
  }
  if (!props.has('name')) {
    diagnostics.push(markerAt(arg, sf, `computed() missing required 'name' property`, 'error'));
  }
  if (!props.has('watch')) {
    diagnostics.push(markerAt(arg, sf, `computed() missing required 'watch' property — array of entity IDs to observe`, 'error'));
  }
  if (!props.has('compute')) {
    diagnostics.push(markerAt(arg, sf, `computed() missing required 'compute' property — function to derive the state`, 'error'));
  }

  // Extract entity ID for duplicate checking (same as regular factories)
  for (const prop of arg.properties) {
    if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) &&
        prop.name.text === 'id' && ts.isStringLiteral(prop.initializer)) {
      const id = prop.initializer.text;
      if (id === '') {
        diagnostics.push(markerAt(prop.initializer, sf, `computed() id must not be empty`, 'error'));
      } else {
        const { line } = sf.getLineAndCharacterOfPosition(prop.initializer.getStart(sf));
        const start = prop.initializer.getStart(sf) - sf.getLineStarts()[line];
        entities.push({
          id,
          line: line + 1,
          startCol: start + 1,
          endCol: start + 1 + prop.initializer.getWidth(sf),
        });

        if (!/^[a-z][a-z0-9_]*$/.test(id)) {
          const suggested = toSnakeCase(id);
          const hint = suggested && suggested !== id ? ` (suggested: '${suggested}')` : '';
          diagnostics.push(markerAt(prop.initializer, sf,
            `Entity ID '${id}' should be snake_case${hint}`,
            'warning',
          ));
        }
      }
    }
  }

  // Check for empty name
  for (const prop of arg.properties) {
    if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) &&
        prop.name.text === 'name' && ts.isStringLiteral(prop.initializer) &&
        prop.initializer.text === '') {
      diagnostics.push(markerAt(prop.initializer, sf, `computed() name must not be empty`, 'warning'));
    }
  }
}

// ---- Entity ID domain mismatch ----

/** Maps factory names to their HA entity domain. */
const FACTORY_DOMAINS: Record<string, string> = {
  sensor: 'sensor',
  binarySensor: 'binary_sensor',
  light: 'light',
  defineSwitch: 'switch',
  cover: 'cover',
  climate: 'climate',
  fan: 'fan',
  lock: 'lock',
  number: 'number',
  select: 'select',
  text: 'text',
  button: 'button',
  siren: 'siren',
  humidifier: 'humidifier',
  valve: 'valve',
  waterHeater: 'water_heater',
  vacuum: 'vacuum',
  lawnMower: 'lawn_mower',
  alarmControlPanel: 'alarm_control_panel',
};

function checkIdDomainMismatch(
  factoryName: string,
  idNode: import('typescript').StringLiteral,
  sf: import('typescript').SourceFile,
  diagnostics: AnalyzerDiagnostic[],
) {
  if (!ts) return;
  const id = idNode.text;
  const ownDomain = FACTORY_DOMAINS[factoryName];
  if (!ownDomain) return;

  // Check if the ID starts with a different domain prefix
  for (const [, domain] of Object.entries(FACTORY_DOMAINS)) {
    if (domain === ownDomain) continue;
    if (id.startsWith(domain + '_')) {
      diagnostics.push(markerAt(idNode, sf,
        `Entity ID '${id}' starts with '${domain}_' but this is a ${ownDomain} — the full entity ID will be ${ownDomain}.${id}`,
        'info',
      ));
      return;
    }
  }
}

// ---- Sensor config validation ----

/** Default units for common sensor device classes. */
const DEVICE_CLASS_UNITS: Record<string, string> = {
  temperature: '°C',
  humidity: '%',
  pressure: 'hPa',
  power: 'W',
  energy: 'kWh',
  voltage: 'V',
  current: 'A',
  frequency: 'Hz',
  illuminance: 'lx',
  speed: 'm/s',
  distance: 'm',
  weight: 'kg',
  volume: 'L',
  gas: 'm³',
  carbon_dioxide: 'ppm',
  carbon_monoxide: 'ppm',
  battery: '%',
  signal_strength: 'dBm',
  moisture: '%',
  pm25: 'µg/m³',
  pm10: 'µg/m³',
  duration: 's',
};

function checkSensorConfig(
  node: import('typescript').CallExpression,
  sf: import('typescript').SourceFile,
  diagnostics: AnalyzerDiagnostic[],
) {
  if (!ts) return;
  const name = getCalledName(node);
  if (name !== 'sensor') return;

  const arg = node.arguments[0];
  if (!arg || !ts.isObjectLiteralExpression(arg)) return;

  // Find the config property
  for (const prop of arg.properties) {
    if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;
    if (prop.name.text !== 'config' || !ts.isObjectLiteralExpression(prop.initializer)) continue;

    const configProps = new Map<string, import('typescript').Node>();
    for (const cp of prop.initializer.properties) {
      if (ts.isPropertyAssignment(cp) && ts.isIdentifier(cp.name)) {
        configProps.set(cp.name.text, cp.initializer);
      }
    }

    const deviceClassNode = configProps.get('device_class');
    if (deviceClassNode && ts.isStringLiteral(deviceClassNode)) {
      const deviceClass = deviceClassNode.text;
      if (!configProps.has('unit_of_measurement') && deviceClass in DEVICE_CLASS_UNITS) {
        diagnostics.push(markerAt(deviceClassNode, sf,
          `sensor with device_class '${deviceClass}' should have unit_of_measurement (typically '${DEVICE_CLASS_UNITS[deviceClass]}')`,
          'warning',
        ));
      }
    }
  }
}

// ---- Cron expression validation ----

/** Field ranges for standard 5-field cron: minute, hour, day-of-month, month, day-of-week. */
const CRON_FIELD_RANGES: Array<{ name: string; min: number; max: number }> = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day of week', min: 0, max: 7 },
];

/**
 * Validate a cron expression string. Returns null if valid, or an error message.
 */
function validateCronExpression(expr: string): string | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    return `Cron expression must have 5 fields (minute hour day-of-month month day-of-week), got ${fields.length}`;
  }

  for (let i = 0; i < 5; i++) {
    const err = validateCronField(fields[i], CRON_FIELD_RANGES[i]);
    if (err) return err;
  }
  return null;
}

function validateCronField(field: string, range: { name: string; min: number; max: number }): string | null {
  // Split on commas for list values
  for (const part of field.split(',')) {
    if (part === '') return `Empty value in ${range.name} field`;

    // Handle step: */5 or 1-10/2
    const stepParts = part.split('/');
    if (stepParts.length > 2) return `Invalid step expression '${part}' in ${range.name} field`;

    const base = stepParts[0];
    const step = stepParts[1];

    if (step !== undefined) {
      const stepNum = Number(step);
      if (!Number.isInteger(stepNum) || stepNum < 1) {
        return `Invalid step value '${step}' in ${range.name} field`;
      }
    }

    if (base === '*') continue;

    // Handle range: 1-5
    if (base.includes('-')) {
      const [startStr, endStr, ...extra] = base.split('-');
      if (extra.length > 0) return `Invalid range '${base}' in ${range.name} field`;
      const start = Number(startStr);
      const end = Number(endStr);
      if (!Number.isInteger(start) || !Number.isInteger(end)) {
        return `Invalid range '${base}' in ${range.name} field`;
      }
      if (start < range.min || start > range.max) {
        return `${range.name} value ${start} out of range (${range.min}-${range.max})`;
      }
      if (end < range.min || end > range.max) {
        return `${range.name} value ${end} out of range (${range.min}-${range.max})`;
      }
      if (start > end) {
        return `Invalid range ${start}-${end} in ${range.name} field (start > end)`;
      }
      continue;
    }

    // Single number
    const num = Number(base);
    if (!Number.isInteger(num)) {
      return `Invalid value '${base}' in ${range.name} field`;
    }
    if (num < range.min || num > range.max) {
      return `${range.name} value ${num} out of range (${range.min}-${range.max})`;
    }
  }

  return null;
}

function checkCronExpression(
  node: import('typescript').CallExpression,
  sf: import('typescript').SourceFile,
  diagnostics: AnalyzerDiagnostic[],
) {
  if (!ts) return;
  const name = getCalledName(node);

  // cron() factory — check schedule property
  if (name === 'cron') {
    const arg = node.arguments[0];
    if (!arg || !ts.isObjectLiteralExpression(arg)) return;
    for (const prop of arg.properties) {
      if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) &&
          prop.name.text === 'schedule' && ts.isStringLiteral(prop.initializer)) {
        const err = validateCronExpression(prop.initializer.text);
        if (err) {
          diagnostics.push(markerAt(prop.initializer, sf, err, 'error'));
        }
      }
    }
    return;
  }

  // this.poll({ cron: '...' }) — check cron property in options
  if (ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'poll' &&
      node.arguments.length >= 2) {
    const opts = node.arguments[1];
    if (!ts.isObjectLiteralExpression(opts)) return;
    for (const prop of opts.properties) {
      if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) &&
          prop.name.text === 'cron' && ts.isStringLiteral(prop.initializer)) {
        const err = validateCronExpression(prop.initializer.text);
        if (err) {
          diagnostics.push(markerAt(prop.initializer, sf, err, 'error'));
        }
      }
    }
  }

  // invariant({ check: { cron: '...' } }) — check nested cron
  if (name === 'invariant' && node.arguments.length >= 1) {
    const arg = node.arguments[0];
    if (!ts.isObjectLiteralExpression(arg)) return;
    for (const prop of arg.properties) {
      if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) &&
          prop.name.text === 'check' && ts.isObjectLiteralExpression(prop.initializer)) {
        for (const inner of prop.initializer.properties) {
          if (ts.isPropertyAssignment(inner) && ts.isIdentifier(inner.name) &&
              inner.name.text === 'cron' && ts.isStringLiteral(inner.initializer)) {
            const err = validateCronExpression(inner.initializer.text);
            if (err) {
              diagnostics.push(markerAt(inner.initializer, sf, err, 'error'));
            }
          }
        }
      }
    }
  }
}

// ---- await on factory call ----

function checkAwaitOnFactory(
  node: import('typescript').CallExpression,
  sf: import('typescript').SourceFile,
  diagnostics: AnalyzerDiagnostic[],
) {
  if (!ts) return;
  // Check if this call (or an inner factory via wrappers) is awaited
  const factory = findFactoryCall(node);
  if (!factory) return;
  const factoryName = getCalledName(factory);
  if (!factoryName) return;

  // Walk up to see if we're inside an AwaitExpression
  // Only check the immediate parent chain — don't cross function boundaries
  let current: import('typescript').Node = node;
  while (current.parent) {
    if (ts.isAwaitExpression(current.parent) && current.parent.expression === current) {
      diagnostics.push(markerAt(current.parent, sf,
        `Do not await ${factoryName}() — entity factories return synchronously`,
        'warning',
      ));
      return;
    }
    // Stop at expression boundaries
    if (ts.isExpressionStatement(current.parent)) break;
    if (ts.isVariableDeclaration(current.parent)) break;
    current = current.parent;
  }
}

// ---- this.poll() / this.setTimeout() / this.setInterval() outside init() ----

function checkThisMethodScope(
  node: import('typescript').PropertyAccessExpression,
  sf: import('typescript').SourceFile,
  diagnostics: AnalyzerDiagnostic[],
  methodName: string,
) {
  if (!ts) return;

  // Walk up to find the enclosing function boundary
  let current: import('typescript').Node | undefined = node.parent;
  while (current) {
    if (ts.isMethodDeclaration(current) && current.name && ts.isIdentifier(current.name)) {
      if (current.name.text === 'init' || current.name.text === 'onCommand' || current.name.text === 'destroy') {
        return; // Valid scope
      }
      break;
    }
    if (ts.isFunctionExpression(current) || ts.isArrowFunction(current)) {
      // Check if this function is the value of an init/onCommand/destroy property
      if (current.parent && ts.isPropertyAssignment(current.parent) &&
          ts.isIdentifier(current.parent.name)) {
        const propName = current.parent.name.text;
        if (propName === 'init' || propName === 'onCommand' || propName === 'destroy') {
          return; // Valid scope
        }
      }
      // Arrow/function inside init is fine (callbacks within init)
      // Keep walking up to see if we're nested inside init
      current = current.parent;
      continue;
    }
    current = current.parent;
  }

  diagnostics.push(markerAt(node, sf,
    `this.${methodName}() should be called inside init(), onCommand(), or destroy()`,
    'warning',
  ));
}

// ---- Bare setTimeout/setInterval ----

function checkBareTimer(
  node: import('typescript').CallExpression,
  sf: import('typescript').SourceFile,
  diagnostics: AnalyzerDiagnostic[],
  name: string,
) {
  if (!ts) return;

  // Check we're inside an init/onCommand/destroy scope (entity context)
  // If so, suggest this.setTimeout instead
  let current: import('typescript').Node | undefined = node.parent;
  let insideEntityMethod = false;
  while (current) {
    if (ts.isMethodDeclaration(current) && current.name && ts.isIdentifier(current.name)) {
      if (['init', 'onCommand', 'destroy'].includes(current.name.text)) {
        insideEntityMethod = true;
      }
      break;
    }
    if (ts.isFunctionExpression(current) || ts.isArrowFunction(current)) {
      if (current.parent && ts.isPropertyAssignment(current.parent) &&
          ts.isIdentifier(current.parent.name) &&
          ['init', 'onCommand', 'destroy'].includes(current.parent.name.text)) {
        insideEntityMethod = true;
        break;
      }
    }
    current = current.parent;
  }

  if (insideEntityMethod) {
    diagnostics.push(markerAt(node.expression, sf,
      `Use this.${name}() instead of ${name}() — managed timers are auto-cleared on teardown`,
      'warning',
    ));
  }
}

// ---- Duplicate entity IDs ----

function checkDuplicateIds(entities: EntityInfo[], diagnostics: AnalyzerDiagnostic[]) {
  const seen = new Map<string, EntityInfo>();
  for (const entity of entities) {
    const prev = seen.get(entity.id);
    if (prev) {
      diagnostics.push({
        startLine: entity.line,
        startCol: entity.startCol,
        endLine: entity.line,
        endCol: entity.endCol,
        message: `Duplicate entity ID '${entity.id}' (first defined on line ${prev.line})`,
        severity: 'error',
      });
    } else {
      seen.set(entity.id, entity);
    }
  }
}

// ---- Unexported entity definitions ----

function checkUnexportedEntities(
  sf: import('typescript').SourceFile,
  diagnostics: AnalyzerDiagnostic[],
) {
  if (!ts) return;

  // Collect names that are re-exported via `export { name }` statements
  const reExported = new Set<string>();
  for (const stmt of sf.statements) {
    if (ts.isExportDeclaration(stmt) && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
      for (const spec of stmt.exportClause.elements) {
        reExported.add((spec.propertyName ?? spec.name).text);
      }
    }
  }

  for (const stmt of sf.statements) {
    // Bare factory/wrapper call as expression statement: sensor({...}) or debounced(sensor({...}))
    if (ts.isExpressionStatement(stmt) && ts.isCallExpression(stmt.expression)) {
      const factory = findFactoryCall(stmt.expression);
      if (factory) {
        const factoryName = getCalledName(factory);
        const varName = suggestVarName(factory);
        const hint = varName ? ` [export const ${varName}]` : '';
        diagnostics.push(markerAt(stmt.expression, sf,
          `${factoryName}() result is not assigned or exported — it will not be deployed${hint}`,
          'warning',
        ));
      }
    }

    // Variable declaration without export: const x = sensor({...}) or const x = debounced(sensor({...}))
    if (ts.isVariableStatement(stmt) && !hasExportModifier(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (!decl.initializer || !ts.isCallExpression(decl.initializer)) continue;
        const factory = findFactoryCall(decl.initializer);
        if (!factory) continue;
        const factoryName = getCalledName(factory);
        const varName = ts.isIdentifier(decl.name) ? decl.name.text : '?';

        // Skip if re-exported
        if (reExported.has(varName)) continue;

        diagnostics.push(markerAt(decl.name, sf,
          `'${varName}' is created by ${factoryName}() but is not exported — it will not be deployed`,
          'warning',
        ));
      }
    }
  }
}

function hasExportModifier(node: import('typescript').VariableStatement): boolean {
  if (!ts) return false;
  return node.modifiers?.some(m => m.kind === ts!.SyntaxKind.ExportKeyword) ?? false;
}

// ---- Device refactor suggestion ----

interface StandaloneEntity {
  varName: string;
  memberKey: string;
  factoryName: string;
  /** Full source text of the initializer expression (e.g. `sensor({ ... })`) */
  exprText: string;
  /** Source text of the init() body if present, null otherwise */
  initText: string | null;
  /** Source text of the destroy() body if present, null otherwise */
  destroyText: string | null;
  /** Whether init uses only simple this.update/this.attr (safe to auto-rewrite) */
  simpleInit: boolean;
  /** The statement node for range info */
  startLine: number;
  endLine: number;
}

/** Names of factories that can be device members. */
const DEVICE_MEMBER_NAMES = new Set([
  'sensor', 'binarySensor', 'light', 'defineSwitch', 'cover', 'climate',
  'fan', 'lock', 'number', 'select', 'text', 'button', 'siren',
  'humidifier', 'valve', 'waterHeater', 'vacuum', 'lawnMower',
  'alarmControlPanel', 'computed',
  'automation', 'task', 'cron', 'mode',
]);

function collectStandaloneEntities(
  sf: import('typescript').SourceFile,
  sourceText: string,
): StandaloneEntity[] {
  if (!ts) return [];
  const results: StandaloneEntity[] = [];

  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    // Only exported declarations count — unexported ones get a different warning
    if (!hasExportModifier(stmt)) continue;

    for (const decl of stmt.declarationList.declarations) {
      if (!decl.initializer || !ts.isCallExpression(decl.initializer)) continue;
      const factory = findFactoryCall(decl.initializer);
      if (!factory) continue;
      const factoryName = getCalledName(factory);
      if (!factoryName || !DEVICE_MEMBER_NAMES.has(factoryName)) continue;

      const varName = ts.isIdentifier(decl.name) ? decl.name.text : null;
      if (!varName) continue;

      // Extract init/destroy from the factory call's object literal
      const arg = factory.arguments[0];
      let initText: string | null = null;
      let destroyText: string | null = null;
      let simpleInit = true;

      if (arg && ts.isObjectLiteralExpression(arg)) {
        for (const prop of arg.properties) {
          const propName = getPropName(prop);
          if (propName === 'init') {
            initText = extractFunctionBodyText(prop, sourceText);
            simpleInit = checkSimpleInit(prop);
          }
          if (propName === 'destroy') {
            destroyText = extractFunctionBodyText(prop, sourceText);
          }
        }
      }

      // Build expression text without init/destroy (they move to device level)
      const exprText = initText || destroyText
        ? removeInitDestroy(decl.initializer, sourceText, sf)
        : sourceText.slice(decl.initializer.getStart(sf), decl.initializer.getEnd());

      const { line: sl } = sf.getLineAndCharacterOfPosition(stmt.getStart(sf));
      const { line: el } = sf.getLineAndCharacterOfPosition(stmt.getEnd());

      results.push({
        varName,
        memberKey: varName,
        factoryName,
        exprText,
        initText,
        destroyText,
        simpleInit,
        startLine: sl + 1,
        endLine: el + 1,
      });
    }
  }

  return results;
}

function getPropName(prop: import('typescript').ObjectLiteralElementLike): string | null {
  if (!ts) return null;
  if ((ts.isPropertyAssignment(prop) || ts.isMethodDeclaration(prop)) &&
      prop.name && ts.isIdentifier(prop.name)) {
    return prop.name.text;
  }
  return null;
}

function extractFunctionBodyText(
  prop: import('typescript').ObjectLiteralElementLike,
  sourceText: string,
): string | null {
  if (!ts) return null;
  // Get the full text of the property (e.g. `init() { ... }` or `init: () => { ... }`)
  return sourceText.slice(prop.getStart(), prop.getEnd());
}

/**
 * Check if an init function only uses this.update() and this.attr()
 * (i.e. no this.poll, this.setTimeout, this.setInterval, this.events, etc.)
 */
function checkSimpleInit(prop: import('typescript').ObjectLiteralElementLike): boolean {
  if (!ts) return false;

  let simple = true;
  const REWRITABLE = new Set(['update', 'attr']);

  function walk(node: import('typescript').Node) {
    if (!ts || !simple) return;
    // Look for this.xxx property access
    if (ts.isPropertyAccessExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ThisKeyword) {
      const name = node.name.text;
      if (!REWRITABLE.has(name)) {
        // this.ha, this.events, this.log, this.mqtt etc. are same on device context — fine
        // this.poll, this.setTimeout, this.setInterval are also on device context — fine
        // But this.poll() has different return semantics — mark as not simple
        if (name === 'poll') {
          simple = false;
        }
      }
    }
    ts.forEachChild(node, walk);
  }

  walk(prop);
  return simple;
}

/**
 * Return the expression text with init() and destroy() properties removed.
 */
function removeInitDestroy(
  expr: import('typescript').CallExpression,
  sourceText: string,
  sf: import('typescript').SourceFile,
): string {
  if (!ts) return sourceText.slice(expr.getStart(sf), expr.getEnd());

  const factory = findFactoryCall(expr) ?? expr;
  const arg = factory.arguments[0];
  if (!arg || !ts.isObjectLiteralExpression(arg)) {
    return sourceText.slice(expr.getStart(sf), expr.getEnd());
  }

  // Find init/destroy properties and remove them
  const removals: Array<{ start: number; end: number }> = [];
  const props = arg.properties;
  for (let i = 0; i < props.length; i++) {
    const propName = getPropName(props[i]);
    if (propName === 'init' || propName === 'destroy') {
      let start = props[i].getStart(sf);
      let end = props[i].getEnd();
      // Remove trailing comma if present
      const afterEnd = sourceText.slice(end).match(/^\s*,/);
      if (afterEnd) {
        end += afterEnd[0].length;
      } else if (i > 0) {
        // Remove leading comma instead
        const beforeStart = sourceText.slice(0, start);
        const leadingComma = beforeStart.match(/,\s*$/);
        if (leadingComma) {
          start -= leadingComma[0].length;
        }
      }
      removals.push({ start, end });
    }
  }

  if (removals.length === 0) {
    return sourceText.slice(expr.getStart(sf), expr.getEnd());
  }

  // Build result by splicing out removals
  let result = '';
  let pos = expr.getStart(sf);
  for (const { start, end } of removals.sort((a, b) => a.start - b.start)) {
    result += sourceText.slice(pos, start);
    pos = end;
  }
  result += sourceText.slice(pos, expr.getEnd());
  return result;
}

function checkDeviceRefactor(
  sf: import('typescript').SourceFile,
  diagnostics: AnalyzerDiagnostic[],
  fileName: string,
) {
  if (!ts) return;

  // Skip if file already has a device() call
  for (const stmt of sf.statements) {
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (decl.initializer && ts.isCallExpression(decl.initializer)) {
          const name = getCalledName(decl.initializer);
          if (name === 'device') return;
        }
      }
    }
  }

  const entities = collectStandaloneEntities(sf, sf.getFullText());
  if (entities.length < 2) return;

  // Place diagnostic on the first entity
  diagnostics.push({
    startLine: entities[0].startLine,
    startCol: 1,
    endLine: entities[0].endLine,
    endCol: 1,
    message: `${entities.length} standalone entities could be grouped into a device() [ha-forge:device-refactor]`,
    severity: 'info',
  });
}

/**
 * Generate the refactored source text that wraps standalone entities in a device().
 * Called from the code action provider.
 */
export function generateDeviceRefactor(sourceText: string, fileName: string): string | null {
  if (!ts) return null;

  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const entities = collectStandaloneEntities(sf, sourceText);
  if (entities.length < 2) return null;

  // Derive device ID and name from filename
  const baseName = fileName.replace(/^.*\//, '').replace(/\.\w+$/, '');
  const deviceId = toSnakeCase(baseName) ?? baseName;
  const deviceVarName = toCamelCase(baseName) ?? 'myDevice';
  const deviceDisplayName = deviceId.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

  // Collect init/destroy from entities
  const inits: Array<{ memberKey: string; text: string; simple: boolean }> = [];
  const destroys: Array<{ memberKey: string; text: string }> = [];
  for (const ent of entities) {
    if (ent.initText) inits.push({ memberKey: ent.memberKey, text: ent.initText, simple: ent.simpleInit });
    if (ent.destroyText) destroys.push({ memberKey: ent.memberKey, text: ent.destroyText });
  }

  // Build the members block
  const membersLines = entities.map(ent =>
    `    ${ent.memberKey}: ${ent.exprText},`
  ).join('\n');

  // Build init block
  let initBlock = '';
  if (inits.length > 0) {
    if (inits.length === 1 && inits[0].simple) {
      // Single simple init — rewrite this.update → this.entities.<key>.update
      const rewritten = rewriteInitForDevice(inits[0].text, inits[0].memberKey);
      initBlock = `\n  ${rewritten},`;
    } else {
      // Multiple inits or complex init — comment out with TODO
      const commentedInits = inits.map(i => {
        const lines = i.text.split('\n').map(l => `  // ${l}`).join('\n');
        return `  // --- from ${i.memberKey} ---\n${lines}`;
      }).join('\n');
      initBlock = `\n  // TODO: Migrate init() — replace this.update() with this.entities.<key>.update()\n${commentedInits}\n  // init() {\n  // },`;
    }
  }

  // Build destroy block
  let destroyBlock = '';
  if (destroys.length > 0) {
    const commentedDestroys = destroys.map(d => {
      const lines = d.text.split('\n').map(l => `  // ${l}`).join('\n');
      return `  // --- from ${d.memberKey} ---\n${lines}`;
    }).join('\n');
    destroyBlock = `\n  // TODO: Migrate destroy()\n${commentedDestroys}\n  // destroy() {\n  // },`;
  }

  const deviceDecl = `export const ${deviceVarName} = device({
  id: '${deviceId}',
  name: '${deviceDisplayName}',
  entities: {
${membersLines}
  },${initBlock}${destroyBlock}
});`;

  // Replace the entity declarations in the source with the device declaration
  // Find the range from first entity to last entity
  const lines = sourceText.split('\n');
  const firstLine = entities[0].startLine - 1; // 0-based
  const lastLine = entities[entities.length - 1].endLine; // exclusive

  const before = lines.slice(0, firstLine).join('\n');
  const after = lines.slice(lastLine).join('\n');

  const parts = [before, deviceDecl, after].filter(p => p.length > 0);
  return parts.join('\n\n');
}

/**
 * Rewrite an init property text, replacing this.update/this.attr
 * with this.entities.<key>.update/this.entities.<key>.attr.
 */
function rewriteInitForDevice(initText: string, memberKey: string): string {
  return initText
    .replace(/this\.update\b/g, `this.entities.${memberKey}.update`)
    .replace(/this\.attr\b/g, `this.entities.${memberKey}.attr`);
}

// ---- Fill in device info ----

export interface DeviceInfoInsertion {
  /** Line of the object literal's closing brace (where we insert before) */
  insertLine: number;
  /** Column of the closing brace */
  insertCol: number;
  /** Text to insert (the device property) */
  text: string;
  /** Whether a leading comma is needed */
  needsComma: boolean;
}

/**
 * If the cursor is on a factory call that has no `device` property,
 * return the insertion point and derived device info text.
 */
export function getDeviceInfoInsertion(
  sourceText: string,
  fileName: string,
  cursorLine: number,
): DeviceInfoInsertion | null {
  if (!ts) return null;

  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const baseName = fileName.replace(/^.*\//, '').replace(/\.\w+$/, '');
  const deviceId = toSnakeCase(baseName) ?? baseName;
  const deviceName = deviceId.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

  // Find a factory call at the cursor line
  let result: DeviceInfoInsertion | null = null;

  function visit(node: import('typescript').Node) {
    if (!ts || result) return;

    if (ts.isCallExpression(node)) {
      const factory = findFactoryCall(node);
      if (factory) {
        const arg = factory.arguments[0];
        if (arg && ts.isObjectLiteralExpression(arg)) {
          const { line: objStart } = sf.getLineAndCharacterOfPosition(arg.getStart(sf));
          const { line: objEnd } = sf.getLineAndCharacterOfPosition(arg.getEnd());

          // Check if cursor is within this object literal's range
          if (cursorLine >= objStart + 1 && cursorLine <= objEnd + 1) {
            // Check if device property already exists
            const hasDevice = arg.properties.some(p => getPropName(p) === 'device');
            if (hasDevice) return;

            // Find insertion point: before the closing brace
            const closeBrace = arg.getEnd() - 1; // position of '}'
            const { line: closeLine, character: closeChar } = sf.getLineAndCharacterOfPosition(closeBrace);

            // Check if last property has a trailing comma
            const lastProp = arg.properties[arg.properties.length - 1];
            let needsComma = false;
            if (lastProp) {
              const afterLast = sourceText.slice(lastProp.getEnd(), closeBrace);
              needsComma = !afterLast.includes(',');
            }

            // Detect indentation from existing properties
            let indent = '  ';
            if (arg.properties.length > 0) {
              const firstProp = arg.properties[0];
              const { character } = sf.getLineAndCharacterOfPosition(firstProp.getStart(sf));
              indent = ' '.repeat(character);
            }

            const deviceText = [
              `${indent}device: {`,
              `${indent}  id: '${deviceId}',`,
              `${indent}  name: '${deviceName}',`,
              `${indent}  manufacturer: 'ha-forge',`,
              `${indent}  model: 'User Script',`,
              `${indent}},`,
            ].join('\n');

            result = {
              insertLine: closeLine + 1,
              insertCol: closeChar + 1,
              text: (needsComma ? ',\n' : '\n') + deviceText + '\n',
              needsComma,
            };
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sf);
  return result;
}

// ---- Snake case conversion ----

/**
 * Convert an arbitrary string to snake_case.
 * Returns null if the result would be empty or invalid.
 */
export function toSnakeCase(input: string): string | null {
  const result = input
    // Insert underscore before uppercase runs: "camelCase" → "camel_Case", "XMLParser" → "XML_Parser"
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    // Replace non-alphanumeric with underscore
    .replace(/[^a-zA-Z0-9]/g, '_')
    .toLowerCase()
    // Collapse multiple underscores
    .replace(/_+/g, '_')
    // Trim leading/trailing underscores
    .replace(/^_|_$/g, '');

  if (!result || !/^[a-z][a-z0-9_]*$/.test(result)) return null;
  return result;
}

/** Convert snake_case to camelCase for variable names. */
export function toCamelCase(input: string): string | null {
  const snake = toSnakeCase(input);
  if (!snake) return null;
  return snake.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}

/** Extract the entity ID from a factory call and suggest a camelCase variable name. */
function suggestVarName(factory: import('typescript').CallExpression): string | null {
  if (!ts) return null;
  const arg = factory.arguments[0];
  if (!arg || !ts.isObjectLiteralExpression(arg)) return null;
  for (const prop of arg.properties) {
    if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) &&
        prop.name.text === 'id' && ts.isStringLiteral(prop.initializer)) {
      return toCamelCase(prop.initializer.text);
    }
  }
  return null;
}

// ---- Helpers ----

function markerAt(
  node: import('typescript').Node,
  sf: import('typescript').SourceFile,
  message: string,
  severity: 'error' | 'warning' | 'info',
): AnalyzerDiagnostic {
  const start = node.getStart(sf);
  const end = node.getEnd();
  const { line: startLine, character: startChar } = sf.getLineAndCharacterOfPosition(start);
  const { line: endLine, character: endChar } = sf.getLineAndCharacterOfPosition(end);
  return {
    startLine: startLine + 1,
    startCol: startChar + 1,
    endLine: endLine + 1,
    endCol: endChar + 1,
    message,
    severity,
  };
}

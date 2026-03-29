/**
 * AST-based diagnostic analyzers for Monaco editor.
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
import {
  getTs, getCalledName, findFactoryCall, markerAt, idToTitle, toSnakeCase,
  WRAPPER_NAMES, FACTORY_DOMAINS, getPropName, hasExportModifier,
  type EntityInfo, type AstAnalysisResult,
} from './ast-helpers.js';
import { suggestVarName, collectStandaloneEntities } from './ast-code-actions.js';

/**
 * Run all AST-based analyzers on a source file.
 * Returns diagnostics and extracted entity info (for cross-file analysis).
 */
export function analyzeWithAst(sourceText: string, fileName = 'file.ts'): AstAnalysisResult {
  const ts = getTs();
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

function checkFactoryCall(
  node: import('typescript').CallExpression,
  sf: import('typescript').SourceFile,
  diagnostics: AnalyzerDiagnostic[],
  entities: EntityInfo[],
) {
  const ts = getTs();
  if (!ts) return;
  const name = getCalledName(node);
  if (!name || !FACTORY_NAMES.includes(name)) return;

  // computed() has different required fields (watch, compute)
  if (name === 'computed') {
    checkComputedCall(node, sf, diagnostics, entities);
    return;
  }
  // automation doesn't have a name field
  const requiresName = name !== 'automation';

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
  if (requiresName) {
    const nameNode = props.get('name');
    const nameMissing = !nameNode;
    const nameEmpty = nameNode && ts.isStringLiteral(nameNode) && nameNode.text === '';
    if (nameMissing || nameEmpty) {
      const idNode = props.get('id');
      const suggestedName = idNode && ts.isStringLiteral(idNode) && idNode.text ? idToTitle(idNode.text) : null;
      const hint = suggestedName ? ` (suggested: '${suggestedName}')` : '';
      const target = nameEmpty ? nameNode : arg;
      diagnostics.push(markerAt(target, sf, `${name}() ${nameEmpty ? "name must not be empty" : "missing required 'name' property"}${hint}`, 'error'));
    }
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
  const ts = getTs();
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

    // Check for this.events.stream() pattern
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const prop = node.expression;
      if (prop.name.text === 'stream' && ts.isPropertyAccessExpression(prop.expression) &&
          prop.expression.name.text === 'events' &&
          prop.expression.expression.kind === ts.SyntaxKind.ThisKeyword) {
        hasEventsOn = true;
      }
    }

    // Mutable local state (let declarations) means the entity maintains
    // closure state across events — computed() can't express this
    if (ts.isVariableStatement(node)) {
      const decl = node.declarationList;
      if (!(decl.flags & ts.NodeFlags.Const)) {
        hasOtherLogic = true;
      }
    }

    ts.forEachChild(node, walkInit);
  }

  walkInit(body);

  if (hasEventsOn && hasUpdate && !hasOtherLogic) {
    diagnostics.push(markerAt(initNode, sf,
      `This sensor only watches state and calls this.update() — consider using computed() instead [ha-forge:suggest-computed]`,
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
  const ts = getTs();
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
  {
    let nameNode: import('typescript').Node | undefined;
    let nameMissing = !props.has('name');
    let nameEmpty = false;
    if (!nameMissing) {
      for (const prop of arg.properties) {
        if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === 'name' && ts.isStringLiteral(prop.initializer) && prop.initializer.text === '') {
          nameEmpty = true;
          nameNode = prop.initializer;
          break;
        }
      }
    }
    if (nameMissing || nameEmpty) {
      let suggestedName: string | null = null;
      for (const prop of arg.properties) {
        if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === 'id' && ts.isStringLiteral(prop.initializer) && prop.initializer.text) {
          suggestedName = idToTitle(prop.initializer.text);
          break;
        }
      }
      const hint = suggestedName ? ` (suggested: '${suggestedName}')` : '';
      const target = nameEmpty && nameNode ? nameNode : arg;
      diagnostics.push(markerAt(target, sf, `computed() ${nameEmpty ? "name must not be empty" : "missing required 'name' property"}${hint}`, 'error'));
    }
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

function checkIdDomainMismatch(
  factoryName: string,
  idNode: import('typescript').StringLiteral,
  sf: import('typescript').SourceFile,
  diagnostics: AnalyzerDiagnostic[],
) {
  const ts = getTs();
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
  const ts = getTs();
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
  const ts = getTs();
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
  const ts = getTs();
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
  const ts = getTs();
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
  const ts = getTs();
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
  const ts = getTs();
  if (!ts) return;

  // Collect all names in scope (variables, imports, factory/wrapper function names)
  const usedNames = new Set<string>(
    [...FACTORY_NAMES, ...WRAPPER_NAMES],
  );
  for (const stmt of sf.statements) {
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) usedNames.add(decl.name.text);
      }
    }
    if (ts.isImportDeclaration(stmt) && stmt.importClause) {
      if (stmt.importClause.name) usedNames.add(stmt.importClause.name.text);
      const bindings = stmt.importClause.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const spec of bindings.elements) usedNames.add(spec.name.text);
      }
    }
    if (ts.isFunctionDeclaration(stmt) && stmt.name) usedNames.add(stmt.name.text);
  }

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
        const varName = suggestVarName(factory, factoryName, usedNames, sf.fileName);
        if (varName) usedNames.add(varName); // prevent duplicates across multiple bare calls
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

// ---- Device refactor suggestion ----

function checkDeviceRefactor(
  sf: import('typescript').SourceFile,
  diagnostics: AnalyzerDiagnostic[],
  fileName: string,
) {
  const ts = getTs();
  if (!ts) return;

  // Check if file already has a device() call
  let hasDevice = false;
  for (const stmt of sf.statements) {
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (decl.initializer && ts.isCallExpression(decl.initializer) && getCalledName(decl.initializer) === 'device') {
          hasDevice = true;
        }
      }
    }
    if (ts.isExportAssignment(stmt) && !stmt.isExportEquals && ts.isCallExpression(stmt.expression) && getCalledName(stmt.expression) === 'device') {
      hasDevice = true;
    }
  }

  const entities = collectStandaloneEntities(sf, sf.getFullText());

  if (hasDevice) {
    // Suggest moving standalone entities into the existing device
    for (const ent of entities) {
      diagnostics.push({
        startLine: ent.startLine,
        startCol: 1,
        endLine: ent.endLine,
        endCol: 1,
        message: `'${ent.varName}' could be moved into the device() entities [ha-forge:move-into-device]`,
        severity: 'info',
      });
    }
  } else {
    if (entities.length < 2) return;
    diagnostics.push({
      startLine: entities[0].startLine,
      startCol: 1,
      endLine: entities[0].endLine,
      endCol: 1,
      message: `${entities.length} standalone entities could be grouped into a device() [ha-forge:device-refactor]`,
      severity: 'info',
    });
  }
}

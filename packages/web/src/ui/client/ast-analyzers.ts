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

// ---- Convert sensor to computed() ----

export interface SensorToComputedEdit {
  /** The replacement text (computed({...})) */
  text: string;
  /** Range of the statement to replace (1-based lines) */
  startLine: number;
  endLine: number;
}

/**
 * Convert a sensor-with-events-only init to computed().
 * Returns null if the pattern doesn't match the simple convertible case.
 */
export function generateSensorToComputed(
  sourceText: string,
  fileName: string,
  initLine: number,
): SensorToComputedEdit | null {
  if (!ts) return null;

  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);

  // Find the sensor() call containing the init at this line
  let sensorCall: import('typescript').CallExpression | null = null;
  let outerExpr: import('typescript').CallExpression | null = null;
  let stmt: import('typescript').Statement | null = null;
  let varName: string | null = null;
  let isExported = false;

  for (const s of sf.statements) {
    if (ts.isVariableStatement(s)) {
      isExported = hasExportModifier(s);
      for (const decl of s.declarationList.declarations) {
        if (!decl.initializer || !ts.isCallExpression(decl.initializer)) continue;
        const factory = findFactoryCall(decl.initializer);
        if (!factory || getCalledName(factory) !== 'sensor') continue;

        // Check if the init is on the target line
        const initProp = findPropInFactory(factory, 'init');
        if (!initProp) continue;
        const { line } = sf.getLineAndCharacterOfPosition(initProp.getStart(sf));
        if (line + 1 === initLine) {
          sensorCall = factory;
          outerExpr = decl.initializer;
          stmt = s;
          varName = ts.isIdentifier(decl.name) ? decl.name.text : null;
        }
      }
    }
    if (ts.isExportAssignment(s) && !s.isExportEquals && ts.isCallExpression(s.expression)) {
      const factory = findFactoryCall(s.expression);
      if (!factory || getCalledName(factory) !== 'sensor') continue;
      const initProp = findPropInFactory(factory, 'init');
      if (!initProp) continue;
      const { line } = sf.getLineAndCharacterOfPosition(initProp.getStart(sf));
      if (line + 1 === initLine) {
        sensorCall = factory;
        outerExpr = s.expression;
        stmt = s;
        isExported = true;
      }
    }
  }

  if (!sensorCall || !stmt) return null;

  const arg = sensorCall.arguments[0];
  if (!arg || !ts.isObjectLiteralExpression(arg)) return null;

  // Extract sensor properties
  const sensorProps = new Map<string, import('typescript').Node>();
  for (const prop of arg.properties) {
    const name = getPropName(prop);
    if (name) sensorProps.set(name, prop);
  }

  // Find init body
  const initNode = sensorProps.get('init');
  if (!initNode) return null;
  let initBody: import('typescript').Block | null = null;
  if (ts.isMethodDeclaration(initNode) && initNode.body) initBody = initNode.body;
  if (ts.isFunctionExpression(initNode) && initNode.body) initBody = initNode.body;
  if (ts.isArrowFunction(initNode)) {
    if (ts.isBlock(initNode.body)) initBody = initNode.body;
  }
  if (!initBody) return null;

  // Extract this.events.stream('entityId')...subscribe(callback) patterns
  interface WatchEntry { entityId: string; paramName: string; updateExpr: string }
  const watches: WatchEntry[] = [];

  /**
   * Walk a chain of method calls to find this.events.stream('entityId') at the root.
   * Returns the entity ID string or null.
   */
  const findStreamEntityId = (node: import('typescript').Expression): string | null => {
    if (ts!.isCallExpression(node) && ts!.isPropertyAccessExpression(node.expression)) {
      const prop = node.expression;
      if (prop.name.text === 'stream' &&
          ts!.isPropertyAccessExpression(prop.expression) &&
          prop.expression.name.text === 'events' &&
          prop.expression.expression.kind === ts!.SyntaxKind.ThisKeyword) {
        if (node.arguments.length >= 1 && ts!.isStringLiteral(node.arguments[0])) {
          return node.arguments[0].text;
        }
        return null;
      }
      // Recurse into the chain (e.g. .filter().debounce() wrapping stream())
      return findStreamEntityId(prop.expression);
    }
    return null;
  };

  for (const s of initBody.statements) {
    if (!ts.isExpressionStatement(s) || !ts.isCallExpression(s.expression)) {
      // Allow return statements (initial value)
      if (ts.isReturnStatement(s)) continue;
      return null; // unexpected statement
    }
    const call = s.expression;
    const callProp = call.expression;

    // Match ...subscribe(callback) at the end of the chain
    if (!ts.isPropertyAccessExpression(callProp) || callProp.name.text !== 'subscribe') return null;
    // Walk the chain to find this.events.stream('entityId')
    const entityId = findStreamEntityId(callProp.expression);
    if (!entityId) return null;

    // First arg of .subscribe(): callback — extract parameter name and find this.update(expr)
    if (call.arguments.length < 1) return null;
    const cb = call.arguments[0];
    let paramName = 'e';
    let cbBody: import('typescript').Node | null = null;

    if (ts.isArrowFunction(cb)) {
      if (cb.parameters.length > 0 && ts.isIdentifier(cb.parameters[0].name)) {
        paramName = cb.parameters[0].name.text;
      }
      cbBody = cb.body;
    } else if (ts.isFunctionExpression(cb)) {
      if (cb.parameters.length > 0 && ts.isIdentifier(cb.parameters[0].name)) {
        paramName = cb.parameters[0].name.text;
      }
      cbBody = cb.body;
    }
    if (!cbBody) return null;

    // Extract the update expression: this.update(expr) — may be the body directly or in a block
    let updateExpr: string | null = null;
    if (ts.isBlock(cbBody)) {
      for (const cs of cbBody.statements) {
        if (!ts.isExpressionStatement(cs)) return null;
        updateExpr = extractUpdateExpr(cs.expression, sf, sourceText);
        if (!updateExpr) return null;
      }
    } else {
      // Arrow with expression body: (e) => this.update(expr)
      updateExpr = extractUpdateExpr(cbBody, sf, sourceText);
    }
    if (!updateExpr) return null;

    watches.push({ entityId, paramName, updateExpr });
  }

  if (watches.length === 0) return null;

  // Build compute body — rewrite e.new_state → states['entityId']?.state
  const watchIds = watches.map(w => w.entityId);
  let computeBody: string;
  if (watches.length === 1) {
    let expr = watches[0].updateExpr;
    // Replace paramName.new_state with states['entityId']?.state
    const p = watches[0].paramName;
    expr = expr.replace(new RegExp(`${escapeRegExp(p)}\\.new_state`, 'g'), `states['${watches[0].entityId}']?.state`);
    computeBody = `(states) => ${expr}`;
  } else {
    // Multiple watchers — more complex, generate a block body
    const lines = watches.map(w => {
      let expr = w.updateExpr;
      expr = expr.replace(new RegExp(`${escapeRegExp(w.paramName)}\\.new_state`, 'g'), `states['${w.entityId}']?.state`);
      return expr;
    });
    // This case is tricky — multiple events.on each calling this.update with different logic.
    // For now, use the last one (they all update the same sensor)
    computeBody = `(states) => ${lines[lines.length - 1]}`;
  }

  // Build computed() properties — preserve id, name, config, device; replace init with watch+compute
  const indent = '  ';
  const propLines: string[] = [];
  for (const [key, node] of sensorProps) {
    if (key === 'init' || key === 'destroy') continue;
    propLines.push(`${indent}${sourceText.slice(node.getStart(sf), node.getEnd())},`);
  }
  propLines.push(`${indent}watch: [${watchIds.map(id => `'${id}'`).join(', ')}],`);
  propLines.push(`${indent}compute: ${computeBody},`);

  const computedCall = `computed({\n${propLines.join('\n')}\n})`;

  // Build the full statement
  const stmtStart = sf.getLineAndCharacterOfPosition(stmt.getStart(sf));
  const stmtEnd = sf.getLineAndCharacterOfPosition(stmt.getEnd());

  let fullText: string;
  if (ts.isExportAssignment(stmt)) {
    fullText = `export default ${computedCall};`;
  } else {
    const exportPrefix = isExported ? 'export ' : '';
    const varPrefix = varName ? `${exportPrefix}const ${varName} = ` : exportPrefix;
    fullText = `${varPrefix}${computedCall};`;
  }

  return {
    text: fullText,
    startLine: stmtStart.line + 1,
    endLine: stmtEnd.line + 1,
  };
}

function findPropInFactory(call: import('typescript').CallExpression, propName: string): import('typescript').Node | null {
  if (!ts) return null;
  const arg = call.arguments[0];
  if (!arg || !ts.isObjectLiteralExpression(arg)) return null;
  for (const prop of arg.properties) {
    if (getPropName(prop) === propName) return prop;
  }
  return null;
}

function extractUpdateExpr(
  node: import('typescript').Node,
  sf: import('typescript').SourceFile,
  sourceText: string,
): string | null {
  if (!ts) return null;
  // this.update(expr)
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.kind === ts.SyntaxKind.ThisKeyword &&
      node.expression.name.text === 'update' && node.arguments.length === 1) {
    return sourceText.slice(node.arguments[0].getStart(sf), node.arguments[0].getEnd());
  }
  return null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

/** Maps factory names to their HA entity domain. Exported for CodeLens/inlay hints. */
export const FACTORY_DOMAINS: Record<string, string> = {
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
  computed: 'sensor',
  cron: 'binary_sensor',
  notify: 'notify',
  update: 'update',
  image: 'image',
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
  'notify', 'update', 'image',
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

      // Check if the entity has a device prop that needs stripping
      // (device grouping moves to device level).
      // init/destroy are preserved — autonomous members keep their own lifecycle.
      const arg = factory.arguments[0];
      let hasDevice = false;
      if (arg && ts.isObjectLiteralExpression(arg)) {
        for (const prop of arg.properties) {
          if (getPropName(prop) === 'device') {
            hasDevice = true;
            break;
          }
        }
      }

      const exprText = hasDevice
        ? removePropsFromExpr(decl.initializer, sourceText, sf, ['device'])
        : sourceText.slice(decl.initializer.getStart(sf), decl.initializer.getEnd());

      const { line: sl } = sf.getLineAndCharacterOfPosition(stmt.getStart(sf));
      const { line: el } = sf.getLineAndCharacterOfPosition(stmt.getEnd());

      results.push({
        varName,
        memberKey: varName,
        factoryName,
        exprText,
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

/**
 * Return the expression text with named properties removed from the inner factory call.
 */
function removePropsFromExpr(
  expr: import('typescript').CallExpression,
  sourceText: string,
  sf: import('typescript').SourceFile,
  propsToRemove: string[],
): string {
  if (!ts) return sourceText.slice(expr.getStart(sf), expr.getEnd());

  const factory = findFactoryCall(expr) ?? expr;
  const arg = factory.arguments[0];
  if (!arg || !ts.isObjectLiteralExpression(arg)) {
    return sourceText.slice(expr.getStart(sf), expr.getEnd());
  }

  const removeSet = new Set(propsToRemove);
  const removals: Array<{ start: number; end: number }> = [];
  const props = arg.properties;
  for (let i = 0; i < props.length; i++) {
    const propName = getPropName(props[i]);
    if (propName && removeSet.has(propName)) {
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
  // Clean up consecutive blank lines left by removal
  return result.replace(/\n\s*\n\s*\n/g, '\n\n');
}

function checkDeviceRefactor(
  sf: import('typescript').SourceFile,
  diagnostics: AnalyzerDiagnostic[],
  fileName: string,
) {
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

  // Build the members block — re-indent each expression to 6 spaces
  // init/destroy are preserved on each entity (autonomous members keep their own lifecycle)
  const membersLines = entities.map(ent => {
    const indented = reindent(ent.exprText, 6);
    return `    ${ent.memberKey}: ${indented},`;
  }).join('\n');

  const deviceDecl = `export const ${deviceVarName} = device({
  id: '${deviceId}',
  name: '${deviceDisplayName}',
  entities: {
${membersLines}
  },
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

// ---- Move standalone entity into existing device ----

export interface MoveIntoDeviceEdit {
  /** Member key for the entities block (camelCase var name) */
  memberKey: string;
  /** Text to insert as a new member (already indented) */
  insertText: string;
  /** Line to insert at (end of the entities block, before closing brace) */
  insertLine: number;
  insertCol: number;
  /** Range of the standalone statement to delete */
  deleteStartLine: number;
  deleteEndLine: number;
}

/**
 * Generate edit info for moving a standalone entity into the existing device.
 * Returns null if the entity or device cannot be found.
 */
export function generateMoveIntoDevice(
  sourceText: string,
  fileName: string,
  entityStartLine: number,
): MoveIntoDeviceEdit | null {
  if (!ts) return null;

  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);

  // Find the device() call and its entities block
  let deviceCall: import('typescript').CallExpression | null = null;
  for (const stmt of sf.statements) {
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (decl.initializer && ts.isCallExpression(decl.initializer) && getCalledName(decl.initializer) === 'device') {
          deviceCall = decl.initializer;
        }
      }
    }
    if (ts.isExportAssignment(stmt) && !stmt.isExportEquals && ts.isCallExpression(stmt.expression) && getCalledName(stmt.expression) === 'device') {
      deviceCall = stmt.expression;
    }
  }
  if (!deviceCall) return null;

  // Find the entities property in device({ ..., entities: { ... } })
  const deviceArg = deviceCall.arguments[0];
  if (!deviceArg || !ts.isObjectLiteralExpression(deviceArg)) return null;

  let entitiesObj: import('typescript').ObjectLiteralExpression | null = null;
  for (const prop of deviceArg.properties) {
    if (ts.isPropertyAssignment(prop) && getPropName(prop) === 'entities' && ts.isObjectLiteralExpression(prop.initializer)) {
      entitiesObj = prop.initializer;
      break;
    }
  }
  if (!entitiesObj) return null;

  // Find the standalone entity at the given line
  const entities = collectStandaloneEntities(sf, sourceText);
  const entity = entities.find(e => e.startLine === entityStartLine);
  if (!entity) return null;

  // Find insertion point: just before the closing brace of the entities object
  const closeBrace = entitiesObj.getEnd() - 1; // position of '}'
  const { line: insertLine } = sf.getLineAndCharacterOfPosition(closeBrace);

  // Determine indent from existing members or default to 4 spaces
  let memberIndent = '    '; // 4 spaces default
  if (entitiesObj.properties.length > 0) {
    const firstProp = entitiesObj.properties[0];
    const { character } = sf.getLineAndCharacterOfPosition(firstProp.getStart(sf));
    memberIndent = ' '.repeat(character);
  }

  const indentedExpr = reindent(entity.exprText, memberIndent.length + 2);
  const insertText = `${memberIndent}${entity.memberKey}: ${indentedExpr},\n`;

  return {
    memberKey: entity.memberKey,
    insertText,
    insertLine: insertLine + 1, // 1-based
    insertCol: 1,
    deleteStartLine: entity.startLine,
    deleteEndLine: entity.endLine,
  };
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
/** Convert a snake_case entity ID to a Title Case name. */
export function idToTitle(id: string): string {
  return id
    .split('_')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

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
function suggestVarName(
  factory: import('typescript').CallExpression,
  factoryName: string | null,
  usedNames: Set<string>,
  fileName: string,
): string | null {
  if (!ts) return null;

  // 1. Try id-based camelCase name
  const arg = factory.arguments[0];
  if (arg && ts.isObjectLiteralExpression(arg)) {
    for (const prop of arg.properties) {
      if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) &&
          prop.name.text === 'id' && ts.isStringLiteral(prop.initializer) && prop.initializer.text) {
        const candidate = toCamelCase(prop.initializer.text);
        if (candidate && !usedNames.has(candidate)) return candidate;
      }
    }
  }

  // 2. Try filename + factory: washer.ts + sensor → washerSensor
  if (factoryName) {
    const baseName = fileName.replace(/^.*\//, '').replace(/\.\w+$/, '');
    const baseCC = toCamelCase(baseName);
    if (baseCC) {
      const candidate = baseCC + factoryName.charAt(0).toUpperCase() + factoryName.slice(1);
      if (!usedNames.has(candidate)) return candidate;
    }
  }

  // 3. Factory name with number suffix: sensor1, sensor2, ...
  if (factoryName) {
    for (let n = 1; n <= 99; n++) {
      const candidate = `${factoryName}${n}`;
      if (!usedNames.has(candidate)) return candidate;
    }
  }

  return null;
}

// ---- Helpers ----

/**
 * Re-indent a multi-line code string. Detects the existing minimum indentation
 * and adjusts all lines to the target indent level. The first line is returned
 * without leading whitespace (since it follows `memberKey: ` on the same line).
 */
function reindent(text: string, targetIndent: number): string {
  const lines = text.split('\n');
  if (lines.length <= 1) return text.trim();

  // Find the minimum indentation of non-empty lines (excluding first line)
  let minIndent = Infinity;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().length === 0) continue;
    const indent = line.match(/^(\s*)/)?.[1].length ?? 0;
    if (indent < minIndent) minIndent = indent;
  }
  if (minIndent === Infinity) minIndent = 0;

  const pad = ' '.repeat(targetIndent);
  const result = [lines[0].trim()];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().length === 0) {
      result.push('');
    } else {
      result.push(pad + line.slice(minIndent));
    }
  }
  return result.join('\n');
}

// ---- Cron string finder (for hover tooltips) ----

export interface CronStringLocation {
  value: string;
  startLine: number;  // 1-based
  startCol: number;   // 1-based
  endLine: number;
  endCol: number;
}

/** Find all cron expression string literals in the source (schedule: and cron: properties). */
export function findCronStrings(sourceText: string, fileName = 'file.ts'): CronStringLocation[] {
  if (!ts) return [];
  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const results: CronStringLocation[] = [];

  function visit(node: import('typescript').Node) {
    if (ts!.isStringLiteral(node) && ts!.isPropertyAssignment(node.parent)) {
      const propName = ts!.isIdentifier(node.parent.name) ? node.parent.name.text : null;
      if (propName === 'schedule' || propName === 'cron') {
        const start = node.getStart(sf);
        const end = node.getEnd();
        const { line: sl, character: sc } = sf.getLineAndCharacterOfPosition(start);
        const { line: el, character: ec } = sf.getLineAndCharacterOfPosition(end);
        results.push({
          value: node.text,
          startLine: sl + 1,
          startCol: sc + 1,
          endLine: el + 1,
          endCol: ec + 1,
        });
      }
    }
    ts!.forEachChild(node, visit);
  }
  visit(sf);
  return results;
}

// ---- Entity definition finder (for CodeLens, highlights, minimap) ----

export interface EntityDefinitionLocation {
  /** The entity ID from the `id:` property (e.g. 'living_room_temperature') */
  entityId: string;
  /** Full HA entity ID (e.g. 'sensor.living_room_temperature'), or 'device.{id}' for devices */
  fullEntityId: string;
  /** Factory function name (e.g. 'sensor', 'binarySensor', 'device') */
  factoryName: string;
  /** HA domain (e.g. 'sensor', 'binary_sensor'), or 'device' for devices */
  domain: string;
  /** Whether the definition is exported */
  isExported: boolean;
  /** 1-based line of the declaration/expression start */
  line: number;
  /** 1-based end line */
  endLine: number;
  /** Number of member entities (only for device definitions) */
  memberCount?: number;
  /** Behavior wrapper name if wrapped (e.g. 'debounced', 'filtered', 'sampled', 'buffered') */
  wrapper?: string;
  /** Literal params passed to the behavior wrapper (e.g. { wait: 500 } or { interval: 30000 }) */
  wrapperParams?: Record<string, unknown>;
}

/** Extract wrapper name and params from an outer call if it's a behavior wrapper. */
function extractWrapperInfo(outerCall: import('typescript').CallExpression): { wrapper: string; wrapperParams: Record<string, unknown> } | null {
  if (!ts) return null;
  const name = getCalledName(outerCall);
  if (!name || !WRAPPER_NAMES.has(name)) return null;
  // Wrapper params are in the second argument: debounced(factory({...}), { wait: 500 })
  const paramsArg = outerCall.arguments[1];
  const wrapperParams = paramsArg ? extractObjectLiteral(paramsArg) : {};
  return { wrapper: name, wrapperParams };
}

/** Find all entity definitions in source with their positions and HA entity IDs. */
export function findEntityDefinitions(sourceText: string, fileName = 'file.ts'): EntityDefinitionLocation[] {
  if (!ts) return [];
  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const results: EntityDefinitionLocation[] = [];

  function visit(node: import('typescript').Node) {
    // Match: [export] const x = [wrapper(] factory({id: '...'}) [)]
    if (ts!.isVariableStatement(node)) {
      const isExported = node.modifiers?.some(m => m.kind === ts!.SyntaxKind.ExportKeyword) ?? false;
      for (const decl of node.declarationList.declarations) {
        if (!decl.initializer || !ts!.isCallExpression(decl.initializer)) continue;
        const outerCall = decl.initializer;
        const outerName = getCalledName(outerCall);

        // device() calls — push device + each member entity
        if (outerName === 'device') {
          const entityId = extractEntityId(outerCall);
          if (entityId) {
            const startPos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
            const endPos = sf.getLineAndCharacterOfPosition(node.getEnd());
            results.push({
              entityId,
              fullEntityId: `device.${entityId}`,
              factoryName: 'device',
              domain: 'device',
              isExported,
              line: startPos.line + 1,
              endLine: endPos.line + 1,
              memberCount: countDeviceMembers(outerCall),
            });
          }
          collectDeviceMembers(outerCall, sf, isExported, results);
          continue; // members already collected, skip standalone check
        }

        // Standalone entity factory calls (including wrapped)
        const call = findFactoryCall(outerCall);
        if (call) {
          const factoryName = getCalledName(call);
          if (factoryName) {
            const domain = FACTORY_DOMAINS[factoryName];
            if (domain) {
              const entityId = extractEntityId(call);
              if (entityId) {
                const startPos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
                const endPos = sf.getLineAndCharacterOfPosition(node.getEnd());
                const wrapperInfo = extractWrapperInfo(outerCall);
                results.push({
                  entityId,
                  fullEntityId: `${domain}.${entityId}`,
                  factoryName,
                  domain,
                  isExported,
                  line: startPos.line + 1,
                  endLine: endPos.line + 1,
                  ...(wrapperInfo && { wrapper: wrapperInfo.wrapper, wrapperParams: wrapperInfo.wrapperParams }),
                });
              }
            }
          }
        }
      }
    }

    // Match: export default [wrapper(] factory({id: '...'}) [)]
    if (ts!.isExportAssignment(node) && !node.isExportEquals && ts!.isCallExpression(node.expression)) {
      const outerCall = node.expression;
      const outerName = getCalledName(outerCall);

      if (outerName === 'device') {
        const entityId = extractEntityId(outerCall);
        if (entityId) {
          const startPos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          const endPos = sf.getLineAndCharacterOfPosition(node.getEnd());
          results.push({
            entityId,
            fullEntityId: `device.${entityId}`,
            factoryName: 'device',
            domain: 'device',
            isExported: true,
            line: startPos.line + 1,
            endLine: endPos.line + 1,
            memberCount: countDeviceMembers(outerCall),
          });
        }
        collectDeviceMembers(outerCall, sf, true, results);
      } else {
        const call = findFactoryCall(outerCall);
        if (call) {
          const factoryName = getCalledName(call);
          if (factoryName) {
            const domain = FACTORY_DOMAINS[factoryName];
            if (domain) {
              const entityId = extractEntityId(call);
              if (entityId) {
                const startPos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
                const endPos = sf.getLineAndCharacterOfPosition(node.getEnd());
                const wrapperInfo = extractWrapperInfo(outerCall);
                results.push({
                  entityId,
                  fullEntityId: `${domain}.${entityId}`,
                  factoryName,
                  domain,
                  isExported: true,
                  line: startPos.line + 1,
                  endLine: endPos.line + 1,
                  ...(wrapperInfo && { wrapper: wrapperInfo.wrapper, wrapperParams: wrapperInfo.wrapperParams }),
                });
              }
            }
          }
        }
      }
    }

    ts!.forEachChild(node, visit);
  }
  visit(sf);
  return results;
}

function extractEntityId(call: import('typescript').CallExpression): string | null {
  if (!ts) return null;
  const arg = call.arguments[0];
  if (!arg || !ts.isObjectLiteralExpression(arg)) return null;
  for (const prop of arg.properties) {
    if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) &&
        prop.name.text === 'id' && ts.isStringLiteral(prop.initializer)) {
      return prop.initializer.text;
    }
  }
  return null;
}

/** Count the number of properties in a device()'s `entities:` object. */
function countDeviceMembers(call: import('typescript').CallExpression): number {
  if (!ts) return 0;
  const arg = call.arguments[0];
  if (!arg || !ts.isObjectLiteralExpression(arg)) return 0;
  for (const prop of arg.properties) {
    if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) &&
        prop.name.text === 'entities' && ts.isObjectLiteralExpression(prop.initializer)) {
      return prop.initializer.properties.length;
    }
  }
  return 0;
}

/** Extract member entity definitions from a device()'s `entities:` object. */
function collectDeviceMembers(
  deviceCall: import('typescript').CallExpression,
  sf: import('typescript').SourceFile,
  isExported: boolean,
  results: EntityDefinitionLocation[],
) {
  if (!ts) return;
  const arg = deviceCall.arguments[0];
  if (!arg || !ts.isObjectLiteralExpression(arg)) return;

  for (const prop of arg.properties) {
    if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name) ||
        prop.name.text !== 'entities') continue;
    if (!ts.isObjectLiteralExpression(prop.initializer)) continue;

    for (const member of prop.initializer.properties) {
      if (!ts.isPropertyAssignment(member)) continue;
      // The value should be a factory call (possibly wrapped)
      if (!ts.isCallExpression(member.initializer)) continue;
      const call = findFactoryCall(member.initializer);
      if (!call) continue;
      const factoryName = getCalledName(call);
      if (!factoryName) continue;
      const domain = FACTORY_DOMAINS[factoryName];
      if (!domain) continue;
      const entityId = extractEntityId(call);
      if (!entityId) continue;

      const startPos = sf.getLineAndCharacterOfPosition(member.getStart(sf));
      const endPos = sf.getLineAndCharacterOfPosition(member.getEnd());
      results.push({
        entityId,
        fullEntityId: `${domain}.${entityId}`,
        factoryName,
        domain,
        isExported,
        line: startPos.line + 1,
        endLine: endPos.line + 1,
      });
    }
  }
}

// ---- Entity dependency analysis (for CodeLens) ----

export interface EntityDependencies {
  watches: string[];
  controls: string[];
}

/**
 * Find reactive dependencies for each entity in the source.
 * Returns a map from fullEntityId to its watch/control dependencies.
 * Only detects string literals — variable references are not resolved.
 */
export function findEntityDependencies(sourceText: string, fileName = 'file.ts'): Map<string, EntityDependencies> {
  if (!ts) return new Map();

  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const defs = findEntityDefinitions(sourceText, fileName);
  const result = new Map<string, EntityDependencies>();

  // Initialize empty deps for each entity
  for (const def of defs) {
    result.set(def.fullEntityId, { watches: [], controls: [] });
  }

  // Find which entity def a line belongs to
  function findOwnerEntity(line: number): EntityDefinitionLocation | undefined {
    return defs.find(d => line >= d.line && line <= d.endLine);
  }

  function extractStringLiterals(node: import('typescript').Node): string[] {
    if (!ts) return [];
    if (ts.isStringLiteral(node)) return [node.text];
    if (ts.isArrayLiteralExpression(node)) {
      return node.elements
        .filter((el): el is import('typescript').StringLiteral => ts!.isStringLiteral(el))
        .map(el => el.text);
    }
    return [];
  }

  function visit(node: import('typescript').Node) {
    if (ts!.isCallExpression(node)) {
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      const owner = findOwnerEntity(line);

      if (owner) {
        const dep = result.get(owner.fullEntityId)!;
        const expr = node.expression;

        // this.events.on / this.events.reactions / this.events.combine / this.events.withState / this.events.watchdog
        if (ts!.isPropertyAccessExpression(expr)) {
          const methodName = expr.name.text;
          const obj = expr.expression;

          // Check for this.events.* pattern
          if (ts!.isPropertyAccessExpression(obj) &&
              obj.name.text === 'events' &&
              obj.expression.kind === ts!.SyntaxKind.ThisKeyword) {
            if ((methodName === 'stream' || methodName === 'watchdog') && node.arguments.length > 0) {
              const ids = extractStringLiterals(node.arguments[0]);
              for (const id of ids) if (!dep.watches.includes(id)) dep.watches.push(id);
            }
            if (methodName === 'combine' && node.arguments.length > 0) {
              const ids = extractStringLiterals(node.arguments[0]);
              for (const id of ids) if (!dep.watches.includes(id)) dep.watches.push(id);
            }
            if (methodName === 'withState' && node.arguments.length > 1) {
              const ids0 = extractStringLiterals(node.arguments[0]);
              const ids1 = extractStringLiterals(node.arguments[1]);
              for (const id of [...ids0, ...ids1]) if (!dep.watches.includes(id)) dep.watches.push(id);
            }
            if (methodName === 'reactions' && node.arguments.length > 0) {
              const arg = node.arguments[0];
              if (ts!.isObjectLiteralExpression(arg)) {
                for (const prop of arg.properties) {
                  if (ts!.isPropertyAssignment(prop)) {
                    let key: string | null = null;
                    if (ts!.isStringLiteral(prop.name)) key = prop.name.text;
                    else if (ts!.isIdentifier(prop.name)) key = prop.name.text;
                    if (key && !dep.watches.includes(key)) dep.watches.push(key);
                  }
                }
              }
            }
          }

          // this.ha.callService / ha.callService
          if (methodName === 'callService') {
            const isThisHa = ts!.isPropertyAccessExpression(obj) &&
              obj.name.text === 'ha' &&
              obj.expression.kind === ts!.SyntaxKind.ThisKeyword;
            const isGlobalHa = ts!.isIdentifier(obj) && obj.text === 'ha';
            if ((isThisHa || isGlobalHa) && node.arguments.length > 0) {
              const ids = extractStringLiterals(node.arguments[0]);
              for (const id of ids) if (!dep.controls.includes(id)) dep.controls.push(id);
            }
          }
        }

        // computed({ watch: [...] }) — check if this is a computed factory call
        if (ts!.isIdentifier(node.expression) && node.expression.text === 'computed' && node.arguments.length > 0) {
          const arg = node.arguments[0];
          if (ts!.isObjectLiteralExpression(arg)) {
            for (const prop of arg.properties) {
              if (ts!.isPropertyAssignment(prop) && ts!.isIdentifier(prop.name) && prop.name.text === 'watch') {
                const ids = extractStringLiterals(prop.initializer);
                for (const id of ids) if (!dep.watches.includes(id)) dep.watches.push(id);
              }
            }
          }
        }
      }
    }

    ts!.forEachChild(node, visit);
  }

  visit(sf);

  // Remove entities with no dependencies
  for (const [key, dep] of result) {
    if (dep.watches.length === 0 && dep.controls.length === 0) {
      result.delete(key);
    }
  }

  return result;
}

/** Extract literal values from an AST object literal expression (numbers, strings, arrays of numbers). */
export function extractObjectLiteral(node: import('typescript').Node): Record<string, unknown> {
  if (!ts || !ts.isObjectLiteralExpression(node)) return {};
  const result: Record<string, unknown> = {};
  for (const prop of node.properties) {
    if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;
    const key = prop.name.text;
    const val = prop.initializer;
    if (ts.isNumericLiteral(val)) {
      result[key] = Number(val.text);
    } else if (ts.isStringLiteral(val)) {
      result[key] = val.text;
    } else if (ts.isPrefixUnaryExpression(val) && val.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(val.operand)) {
      result[key] = -Number(val.operand.text);
    } else if (ts.isArrayLiteralExpression(val)) {
      const items: unknown[] = [];
      for (const el of val.elements) {
        if (ts.isNumericLiteral(el)) items.push(Number(el.text));
        else if (ts.isStringLiteral(el)) items.push(el.text);
      }
      if (items.length === val.elements.length) result[key] = items;
    }
  }
  return result;
}

// ---- Scenario detection ----

export interface ScenarioLocation {
  name: string;
  sources: string[];  // shadows entity IDs
  line: number;
  endLine: number;
}

/** Find simulate.scenario() calls in source text — extracts names and shadow IDs for the UI picker. */
export function findScenarios(sourceText: string, fileName = 'file.ts'): ScenarioLocation[] {
  if (!ts) return [];
  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const results: ScenarioLocation[] = [];

  function visit(node: import('typescript').Node) {
    if (ts!.isCallExpression(node) && ts!.isPropertyAccessExpression(node.expression) &&
        ts!.isIdentifier(node.expression.expression) && node.expression.expression.text === 'simulate' &&
        node.expression.name.text === 'scenario') {
      if (node.arguments.length < 2) { ts!.forEachChild(node, visit); return; }

      const nameArg = node.arguments[0];
      if (!ts!.isStringLiteral(nameArg)) { ts!.forEachChild(node, visit); return; }
      const name = nameArg.text;

      const sourcesArg = node.arguments[1];
      if (!ts!.isArrayLiteralExpression(sourcesArg)) { ts!.forEachChild(node, visit); return; }

      const shadows: string[] = [];
      for (const el of sourcesArg.elements) {
        if (!ts!.isObjectLiteralExpression(el)) continue;
        for (const prop of el.properties) {
          if (!ts!.isPropertyAssignment(prop) || !ts!.isIdentifier(prop.name)) continue;
          if (prop.name.text === 'shadows' && ts!.isStringLiteral(prop.initializer)) {
            shadows.push(prop.initializer.text);
          }
        }
      }

      if (shadows.length > 0) {
        const { line: startLine } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        const { line: endLine } = sf.getLineAndCharacterOfPosition(node.getEnd());
        results.push({ name, sources: shadows, line: startLine + 1, endLine: endLine + 1 });
      }
    }
    ts!.forEachChild(node, visit);
  }

  visit(sf);
  return results;
}

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

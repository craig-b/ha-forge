/**
 * AST-based structure finders for CodeLens, minimap, hover tooltips, and the entity dashboard.
 *
 * Extracted from ast-analyzers.ts — these functions locate entity definitions,
 * cron strings, dependency graphs, and scenarios in source files.
 */

import {
  getTs, getCalledName, findFactoryCall, extractObjectLiteral,
  WRAPPER_NAMES, FACTORY_DOMAINS, getPropName,
} from './ast-helpers.js';

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
  const ts = getTs();
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
  const ts = getTs();
  if (!ts) return null;
  const name = getCalledName(outerCall);
  if (!name || !WRAPPER_NAMES.has(name)) return null;
  // Wrapper params are in the second argument: debounced(factory({...}), { wait: 500 })
  const paramsArg = outerCall.arguments[1];
  const wrapperParams = paramsArg ? extractObjectLiteral(paramsArg) : {};
  return { wrapper: name, wrapperParams };
}

function extractEntityId(call: import('typescript').CallExpression): string | null {
  const ts = getTs();
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
  const ts = getTs();
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
  const ts = getTs();
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

/** Find all entity definitions in source with their positions and HA entity IDs. */
export function findEntityDefinitions(sourceText: string, fileName = 'file.ts'): EntityDefinitionLocation[] {
  const ts = getTs();
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
  const ts = getTs();
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

// ---- Scenario detection ----

export interface ScenarioLocation {
  name: string;
  sources: string[];  // shadows entity IDs
  line: number;
  endLine: number;
}

/** Find simulate.scenario() calls in source text — extracts names and shadow IDs for the UI picker. */
export function findScenarios(sourceText: string, fileName = 'file.ts'): ScenarioLocation[] {
  const ts = getTs();
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

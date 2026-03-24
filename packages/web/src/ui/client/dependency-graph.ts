/**
 * Builds forward-edge dependency graphs from simulations to leaf entities.
 * Uses entity definitions and dependencies from AST analysis.
 */

import type { EntityDefinitionLocation, EntityDependencies, SimulationLocation, StreamSubscriptionLocation } from './ast-analyzers.js';
import type { OperatorDescriptor } from './simulation.js';

export interface ChainNode {
  entityId: string;
  kind: 'simulate' | 'computed' | 'sensor' | 'automation' | 'other';
  wrapper?: string;
  wrapperParams?: Record<string, unknown>;
  watches: string[];
  streamOps?: OperatorDescriptor[];
  simulability: 'safe' | 'unsafe' | 'partial';
  unsafeReason?: string;
  sourceFile: string;
}

export interface ChainPath {
  simulationId: string;
  nodes: ChainNode[];
}

interface FileData {
  path: string;
  content: string;
}

/**
 * Build chain paths from simulations to downstream entities.
 * Each chain starts with a simulate() node and follows the dependency graph forward.
 */
export function buildChainPaths(
  simulations: SimulationLocation[],
  allDefs: EntityDefinitionLocation[],
  allDeps: Map<string, EntityDependencies>,
  allStreams: StreamSubscriptionLocation[],
  fileDataByEntity: Map<string, string>,
): ChainPath[] {
  // Build reverse index: entity X is watched by entities [A, B, ...]
  const watchedBy = new Map<string, string[]>();
  for (const [entityId, deps] of allDeps) {
    for (const watched of deps.watches) {
      const list = watchedBy.get(watched) || [];
      list.push(entityId);
      watchedBy.set(watched, list);
    }
  }

  // Index definitions by fullEntityId
  const defByEntity = new Map<string, EntityDefinitionLocation>();
  for (const def of allDefs) {
    defByEntity.set(def.fullEntityId, def);
  }

  // Index streams by entity ID (the entity being streamed)
  const streamsByEntity = new Map<string, StreamSubscriptionLocation[]>();
  for (const stream of allStreams) {
    const list = streamsByEntity.get(stream.entityId) || [];
    list.push(stream);
    streamsByEntity.set(stream.entityId, list);
  }

  const paths: ChainPath[] = [];

  for (const sim of simulations) {
    const visited = new Set<string>();
    const nodes: ChainNode[] = [];

    // Start node: the simulated entity
    nodes.push({
      entityId: sim.shadows,
      kind: 'simulate',
      watches: [],
      simulability: 'safe',
      sourceFile: '',
    });
    visited.add(sim.shadows);

    // Walk forward from shadows
    const queue = [sim.shadows];
    while (queue.length > 0) {
      const current = queue.shift()!;
      const downstream = watchedBy.get(current) || [];

      for (const downId of downstream) {
        if (visited.has(downId)) continue;
        visited.add(downId);

        const def = defByEntity.get(downId);
        const deps = allDeps.get(downId);
        const streams = streamsByEntity.get(current)?.filter(s => s.parentEntityId === downId) || [];

        const kind = resolveKind(def);
        const node: ChainNode = {
          entityId: downId,
          kind,
          wrapper: def?.wrapper,
          wrapperParams: def?.wrapperParams,
          watches: deps?.watches || [],
          simulability: 'safe',
          sourceFile: fileDataByEntity.get(downId) || '',
        };

        // Attach stream operators if this entity streams the current entity
        if (streams.length > 0) {
          node.streamOps = streams.flatMap(s => s.operators.map(op => mapOperator(op)));
        }

        nodes.push(node);
        queue.push(downId);
      }
    }

    // Only emit paths with at least one downstream node
    if (nodes.length > 1) {
      paths.push({ simulationId: sim.id, nodes });
    }
  }

  return paths;
}

function resolveKind(def?: EntityDefinitionLocation): ChainNode['kind'] {
  if (!def) return 'other';
  if (def.factoryName === 'computed') return 'computed';
  if (def.factoryName === 'sensor') return 'sensor';
  if (def.factoryName === 'automation') return 'automation';
  return 'other';
}

function mapOperator(op: { name: string; args: unknown[] }): OperatorDescriptor {
  switch (op.name) {
    case 'debounce': return { type: 'debounce', ms: (op.args[0] as number) || 1000 };
    case 'throttle': return { type: 'throttle', ms: (op.args[0] as number) || 1000 };
    case 'distinctUntilChanged': return { type: 'distinctUntilChanged' };
    case 'onTransition': return { type: 'onTransition', from: String(op.args[0] || '*'), to: String(op.args[1] || '*') };
    case 'filter': return { type: 'filter' };
    case 'map': return { type: 'map' };
    default: return { type: 'filter' };
  }
}

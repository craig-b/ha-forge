/**
 * Chain simulation engine.
 * Takes a ChainPath + compiled compute functions + source signal events,
 * and produces events at each stage of the chain.
 */

import type { ChainNode, ChainPath } from './dependency-graph.js';
import type { ComputeFn } from './compute-extractor.js';
import type { SignalEvent, OperatorDescriptor } from './simulation.js';
import { runSimulation } from './simulation.js';

export interface ChainStageResult {
  entityId: string;
  events: SignalEvent[];
  simulated: boolean;
  skipReason?: string;
}

export interface ChainSimulationResult {
  stages: ChainStageResult[];
  sourceEvents: SignalEvent[];
  finalEvents: SignalEvent[];
  finalEntityId: string;
}

interface CompiledChainData {
  computeFns: Map<string, ComputeFn>;
}

/**
 * Run a chain simulation: source signal through each stage, producing events per node.
 */
export function runChainSimulation(
  chain: ChainPath,
  sourceEvents: SignalEvent[],
  compiled: CompiledChainData,
): ChainSimulationResult {
  const stages: ChainStageResult[] = [];
  // Track latest events per entity ID for fan-in
  const eventsByEntity = new Map<string, SignalEvent[]>();

  // Source node
  const sourceNode = chain.nodes[0];
  eventsByEntity.set(sourceNode.entityId, sourceEvents);
  stages.push({
    entityId: sourceNode.entityId,
    events: sourceEvents,
    simulated: true,
  });

  // Process each downstream node
  for (let i = 1; i < chain.nodes.length; i++) {
    const node = chain.nodes[i];
    const stageResult = simulateNode(node, eventsByEntity, compiled);
    stages.push(stageResult);
    if (stageResult.simulated) {
      eventsByEntity.set(node.entityId, stageResult.events);
    }
  }

  // Final stage is the last one with events
  let finalStage = stages[stages.length - 1];
  for (let i = stages.length - 1; i >= 0; i--) {
    if (stages[i].simulated && stages[i].events.length > 0) {
      finalStage = stages[i];
      break;
    }
  }

  return {
    stages,
    sourceEvents,
    finalEvents: finalStage.events,
    finalEntityId: finalStage.entityId,
  };
}

function simulateNode(
  node: ChainNode,
  eventsByEntity: Map<string, SignalEvent[]>,
  compiled: CompiledChainData,
): ChainStageResult {
  switch (node.kind) {
    case 'computed':
      return simulateComputed(node, eventsByEntity, compiled);
    case 'automation':
      return simulateAutomation(node, eventsByEntity);
    default:
      return simulatePassthrough(node, eventsByEntity);
  }
}

function simulateComputed(
  node: ChainNode,
  eventsByEntity: Map<string, SignalEvent[]>,
  compiled: CompiledChainData,
): ChainStageResult {
  const computeFn = compiled.computeFns.get(node.entityId);
  if (!computeFn) {
    // Check if we have upstream events to pass through
    const upstreamEvents = getUpstreamEvents(node, eventsByEntity);
    return {
      entityId: node.entityId,
      events: upstreamEvents,
      simulated: false,
      skipReason: node.simulability === 'unsafe' ? (node.unsafeReason || 'unsafe compute') : 'no compute function extracted',
    };
  }

  // Gather all upstream timelines
  const upstreamTimelines = new Map<string, SignalEvent[]>();
  let hasAllUpstreams = true;

  for (const watchId of node.watches) {
    const events = eventsByEntity.get(watchId);
    if (events) {
      upstreamTimelines.set(watchId, events);
    } else {
      hasAllUpstreams = false;
      // Use unknown constant for missing upstreams
      upstreamTimelines.set(watchId, [{ t: 0, value: 'unknown' }]);
    }
  }

  // Merge all upstream event timestamps
  const allTimestamps = new Set<number>();
  for (const events of upstreamTimelines.values()) {
    for (const e of events) allTimestamps.add(e.t);
  }
  const sortedTimes = [...allTimestamps].sort((a, b) => a - b);

  // At each timestamp, compute the output using latest values
  const latestValues = new Map<string, string | number>();
  const outputEvents: SignalEvent[] = [];
  let lastOutputValue: string | undefined;
  let timeIdx = 0;

  // Initialize with first values
  for (const [id, events] of upstreamTimelines) {
    if (events.length > 0) latestValues.set(id, events[0].value);
  }

  for (const t of sortedTimes) {
    // Update latest values for this timestamp
    for (const [id, events] of upstreamTimelines) {
      while (timeIdx < events.length && events[timeIdx]?.t <= t) {
        // Scan through events at this timestamp
        // Note: we need per-timeline index, not shared
        break;
      }
      // Find latest event at or before this timestamp
      let latest: SignalEvent | undefined;
      for (const e of events) {
        if (e.t <= t) latest = e;
        else break;
      }
      if (latest) latestValues.set(id, latest.value);
    }

    // Build states record
    const states: Record<string, { state: string | number }> = {};
    for (const watchId of node.watches) {
      states[watchId] = { state: latestValues.get(watchId) ?? 'unknown' };
    }

    try {
      const value = computeFn(states);
      const strValue = String(value);
      // Dedup: skip if same as last output
      if (strValue !== lastOutputValue) {
        outputEvents.push({ t, value: typeof value === 'number' ? value : strValue });
        lastOutputValue = strValue;
      }
    } catch {
      // Compute function threw — skip this timestamp
    }
  }

  // Apply debounce if configured on the entity
  // (debounce property on computed config, not wrapper)
  // For now, return raw computed output

  return {
    entityId: node.entityId,
    events: outputEvents,
    simulated: true,
    ...(!hasAllUpstreams && { skipReason: 'partial: some upstream entities not simulated' }),
  };
}

function simulateAutomation(
  node: ChainNode,
  eventsByEntity: Map<string, SignalEvent[]>,
): ChainStageResult {
  const upstreamEvents = getUpstreamEvents(node, eventsByEntity);

  // If the automation has stream operators, run them through the simulation engine
  if (node.streamOps && node.streamOps.length > 0) {
    const result = runSimulation(upstreamEvents, node.streamOps);
    return {
      entityId: node.entityId,
      events: result.output,
      simulated: true,
    };
  }

  // No operators — just pass through
  return {
    entityId: node.entityId,
    events: upstreamEvents,
    simulated: true,
  };
}

function simulatePassthrough(
  node: ChainNode,
  eventsByEntity: Map<string, SignalEvent[]>,
): ChainStageResult {
  const events = getUpstreamEvents(node, eventsByEntity);
  return {
    entityId: node.entityId,
    events,
    simulated: false,
    skipReason: `${node.kind} entities cannot be simulated`,
  };
}

function getUpstreamEvents(
  node: ChainNode,
  eventsByEntity: Map<string, SignalEvent[]>,
): SignalEvent[] {
  // Merge events from all watched entities
  const allEvents: SignalEvent[] = [];
  for (const watchId of node.watches) {
    const events = eventsByEntity.get(watchId);
    if (events) allEvents.push(...events);
  }
  allEvents.sort((a, b) => a.t - b.t);
  return allEvents;
}

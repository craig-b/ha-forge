import type { HAClientBase, EntityLogger, EventsContext, StatelessHAApi, StateChangedCallback as SDKStateChangedCallback, CombinedState, CombinedCallback, WatchdogRule, InvariantOptions } from '@ha-forge/sdk';
import { createEventStream } from '@ha-forge/sdk';
import type { HAWebSocketClient, HAEvent, HAStateChangedData, HAStateObject } from './ws-client.js';

// ---- Event types ----

export interface StateChangedEvent {
  entity_id: string;
  old_state: string;
  new_state: string;
  old_attributes: Record<string, unknown>;
  new_attributes: Record<string, unknown>;
  timestamp: number;
}

export type StateChangedCallback = (event: StateChangedEvent) => void;

// ---- Reaction map types ----

export interface ReactionRule {
  /** Match when entity transitions to this state */
  to?: string;
  /** Custom condition on the event */
  when?: (event: StateChangedEvent) => boolean;
  /** Action to execute */
  do: () => void | Promise<void>;
  /** Delay in ms before executing — cancelled if state changes again */
  after?: number;
}

// ---- HA API interface ----

export interface HAApi extends HAClientBase {
  on(entityOrDomain: string | string[], callback: StateChangedCallback): () => void;
  callService(entity: string, service: string, data?: Record<string, unknown>): Promise<Record<string, unknown> | null>;
  getState(entityId: string): Promise<{
    state: string;
    attributes: Record<string, unknown>;
    last_changed: string;
    last_updated: string;
  } | null>;
  getEntities(domain?: string): Promise<string[]>;
  reactions(rules: Record<string, ReactionRule>): () => void;
}

/**
 * Full HA client type used by the runtime. This is the string-typed version
 * used internally — typed overloads only exist in generated .d.ts for Monaco.
 */
export type HAClient = HAApi;

/**
 * Stateless HA client type — no on()/reactions() subscriptions.
 * Used as the type for the global `ha` variable.
 */
export type { StatelessHAApi } from '@ha-forge/sdk';

/** Minimal handle tracker interface for scoped event subscriptions. */
export interface EventHandleTracker {
  eventSubscriptions: Array<() => void>;
}

// ---- Implementation ----

export type ValidatorMap = Record<string, Record<string, (value: unknown) => unknown>>;

export class HAApiImpl implements HAApi {
  private wsClient: HAWebSocketClient;
  private subscriptionId: number | null = null;
  private entityCallbacks = new Map<string, Set<StateChangedCallback>>();
  private domainCallbacks = new Map<string, Set<StateChangedCallback>>();
  private reactionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private stateCache = new Map<string, HAStateObject>();
  private validators: ValidatorMap | null;
  readonly log: EntityLogger;

  constructor(wsClient: HAWebSocketClient, logger: EntityLogger, validators?: ValidatorMap | null) {
    this.wsClient = wsClient;
    this.log = logger;
    this.validators = validators ?? null;
  }

  /**
   * Initialize event subscription. Must be called after WS client is connected.
   */
  async init(): Promise<void> {
    this.subscriptionId = await this.wsClient.subscribeEvents('state_changed');
  }

  /**
   * Called by the WS client when an event arrives on our subscription.
   */
  handleEvent(subscriptionId: number, event: HAEvent): void {
    if (subscriptionId !== this.subscriptionId) return;
    if (event.event_type !== 'state_changed') return;

    const data = event.data as unknown as HAStateChangedData;
    if (!data.entity_id || !data.new_state) return;

    // Update state cache
    if (data.new_state) {
      this.stateCache.set(data.entity_id, data.new_state);
    }

    const stateEvent: StateChangedEvent = {
      entity_id: data.entity_id,
      old_state: data.old_state?.state ?? '',
      new_state: data.new_state.state,
      old_attributes: data.old_state?.attributes ?? {},
      new_attributes: data.new_state.attributes,
      timestamp: new Date(event.time_fired).getTime(),
    };

    // Dispatch to entity-specific callbacks
    const entityCbs = this.entityCallbacks.get(data.entity_id);
    if (entityCbs) {
      for (const cb of entityCbs) {
        try { cb(stateEvent); } catch { /* logged by caller */ }
      }
    }

    // Dispatch to domain callbacks
    const domain = data.entity_id.split('.')[0];
    const domainCbs = this.domainCallbacks.get(domain);
    if (domainCbs) {
      for (const cb of domainCbs) {
        try { cb(stateEvent); } catch { /* logged by caller */ }
      }
    }
  }

  on(entityOrDomain: string | string[], callback: StateChangedCallback): () => void {
    const targets = Array.isArray(entityOrDomain) ? entityOrDomain : [entityOrDomain];
    const unsubscribers: Array<() => void> = [];

    for (const target of targets) {
      if (target.includes('.')) {
        // Entity ID (e.g., 'light.living_room')
        let set = this.entityCallbacks.get(target);
        if (!set) {
          set = new Set();
          this.entityCallbacks.set(target, set);
        }
        set.add(callback);
        unsubscribers.push(() => {
          set!.delete(callback);
          if (set!.size === 0) this.entityCallbacks.delete(target);
        });
      } else {
        // Domain (e.g., 'light')
        let set = this.domainCallbacks.get(target);
        if (!set) {
          set = new Set();
          this.domainCallbacks.set(target, set);
        }
        set.add(callback);
        unsubscribers.push(() => {
          set!.delete(callback);
          if (set!.size === 0) this.domainCallbacks.delete(target);
        });
      }
    }

    return () => {
      for (const unsub of unsubscribers) unsub();
    };
  }

  async callService(entity: string, service: string, data?: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const isEntity = entity.includes('.');
    const domain = isEntity ? entity.split('.')[0] : entity;
    const serviceData = data ?? {};

    // Validate parameters using generated validators if available
    if (this.validators) {
      const serviceKey = `${domain}.${service}`;
      const serviceValidators = this.validators[serviceKey];
      if (serviceValidators) {
        for (const [field, validator] of Object.entries(serviceValidators)) {
          if (field in serviceData) {
            validator(serviceData[field]); // throws on invalid input
          }
        }
      }
    }

    const payload: Record<string, unknown> = {
      domain,
      service,
      service_data: serviceData,
    };
    // Only include target when calling on a specific entity (has a dot).
    // Domain-only calls (e.g., 'light') target all entities in the domain.
    if (isEntity) {
      payload.target = { entity_id: entity };
    }

    const result = await this.wsClient.sendCommand('call_service', {
      ...payload,
      return_response: true,
    }) as { response?: Record<string, unknown> } | null;

    return result?.response ?? null;
  }

  async getState(entityId: string): Promise<{
    state: string;
    attributes: Record<string, unknown>;
    last_changed: string;
    last_updated: string;
  } | null> {
    // Check cache first
    const cached = this.stateCache.get(entityId);
    if (cached) {
      return {
        state: cached.state,
        attributes: cached.attributes,
        last_changed: cached.last_changed,
        last_updated: cached.last_updated,
      };
    }

    // Fetch all states and find the one we need
    const result = await this.wsClient.sendCommand('get_states') as HAStateObject[];
    if (!Array.isArray(result)) return null;

    // Update cache with all states
    for (const state of result) {
      this.stateCache.set(state.entity_id, state);
    }

    const state = result.find((s) => s.entity_id === entityId);
    if (!state) return null;

    return {
      state: state.state,
      attributes: state.attributes,
      last_changed: state.last_changed,
      last_updated: state.last_updated,
    };
  }

  async getEntities(domain?: string): Promise<string[]> {
    const result = await this.wsClient.sendCommand('get_states') as HAStateObject[];
    if (!Array.isArray(result)) return [];

    // Update cache
    for (const state of result) {
      this.stateCache.set(state.entity_id, state);
    }

    const entityIds = result.map((s) => s.entity_id);
    if (domain) {
      return entityIds.filter((id) => id.startsWith(`${domain}.`));
    }
    return entityIds;
  }

  async fireEvent(eventType: string, eventData?: Record<string, unknown>): Promise<void> {
    await this.wsClient.sendCommand('fire_event', {
      event_type: eventType,
      event_data: eventData ?? {},
    });
  }

  friendlyName(entityId: string): string {
    const cached = this.stateCache.get(entityId);
    const name = cached?.attributes?.friendly_name;
    return typeof name === 'string' ? name : entityId;
  }

  /**
   * Set up declarative reaction rules.
   * Returns a cleanup function that cancels all pending timers.
   */
  reactions(rules: Record<string, ReactionRule>): () => void {
    const unsubscribers: Array<() => void> = [];

    for (const [entityId, rule] of Object.entries(rules)) {
      const unsub = this.on(entityId, (event) => {
        // Check if condition matches
        let matches = false;

        if (rule.to !== undefined) {
          matches = event.new_state === rule.to;
        } else if (rule.when) {
          matches = rule.when(event);
        } else {
          // No condition — always fires
          matches = true;
        }

        if (!matches) {
          // Cancel any pending delayed reaction for this entity
          const existingTimer = this.reactionTimers.get(entityId);
          if (existingTimer) {
            clearTimeout(existingTimer);
            this.reactionTimers.delete(entityId);
          }
          return;
        }

        if (rule.after) {
          // Cancel any existing timer first
          const existingTimer = this.reactionTimers.get(entityId);
          if (existingTimer) {
            clearTimeout(existingTimer);
          }

          const timer = setTimeout(() => {
            this.reactionTimers.delete(entityId);
            try { rule.do(); } catch { /* swallow */ }
          }, rule.after);
          this.reactionTimers.set(entityId, timer);
        } else {
          try { rule.do(); } catch { /* swallow */ }
        }
      });

      unsubscribers.push(unsub);
    }

    return () => {
      for (const unsub of unsubscribers) unsub();
      // Clear all pending reaction timers
      for (const [key, timer] of this.reactionTimers) {
        clearTimeout(timer);
        this.reactionTimers.delete(key);
      }
    };
  }

  /** Synchronous state lookup from cache. Returns null if not cached. */
  getCachedStateSync(entityId: string): string | null {
    const cached = this.stateCache.get(entityId);
    return cached ? cached.state : null;
  }

  /** Returns a stateless view — no subscriptions or logging, safe to pass around. */
  asStateless(): StatelessHAApi {
    return {
      callService: this.callService.bind(this),
      getState: this.getState.bind(this),
      getEntities: this.getEntities.bind(this),
      fireEvent: this.fireEvent.bind(this),
      friendlyName: this.friendlyName.bind(this),
    };
  }

  /** Creates an EventsContext that tracks subscriptions for lifecycle cleanup. */
  createScopedEvents(handles: EventHandleTracker): EventsContext {
    const self = this;
    return {
      on: (entityOrDomain: string | string[], callback?: SDKStateChangedCallback) => {
        const stream = createEventStream(
          (cb) => self.on(entityOrDomain, cb as StateChangedCallback),
          callback as StateChangedCallback | undefined,
        );
        handles.eventSubscriptions.push(() => stream.unsubscribe());
        return stream;
      },
      reactions: (rules: Record<string, ReactionRule>) => {
        const unsub = self.reactions(rules);
        handles.eventSubscriptions.push(unsub);
        return unsub;
      },
      combine: (entities: string[], callback: CombinedCallback) => {
        const buildSnapshot = (): CombinedState => {
          const states: CombinedState = {};
          for (const eid of entities) {
            states[eid] = self.getCachedStateSync(eid);
          }
          return states;
        };
        const unsub = self.on(entities, () => {
          callback(buildSnapshot());
        });
        handles.eventSubscriptions.push(unsub);
        return unsub;
      },
      withState: (entityOrDomain: string | string[], context: string[], callback: (event: StateChangedEvent, states: CombinedState) => void) => {
        const stream = createEventStream(
          (cb) => self.on(entityOrDomain, cb as StateChangedCallback),
          ((event: StateChangedEvent) => {
            const states: CombinedState = {};
            for (const eid of context) {
              states[eid] = self.getCachedStateSync(eid);
            }
            callback(event, states);
          }) as StateChangedCallback,
        );
        handles.eventSubscriptions.push(() => stream.unsubscribe());
        return stream;
      },
      watchdog: (rules: Record<string, WatchdogRule>) => {
        const timers = new Map<string, ReturnType<typeof setTimeout>>();
        const unsubscribers: Array<() => void> = [];

        const startTimer = (entityId: string, rule: WatchdogRule) => {
          const existing = timers.get(entityId);
          if (existing) clearTimeout(existing);
          const t = setTimeout(() => {
            try { rule.else(); } catch { /* swallow */ }
            // Restart timer — keeps firing if silence continues
            startTimer(entityId, rule);
          }, rule.within);
          timers.set(entityId, t);
        };

        for (const [entityId, rule] of Object.entries(rules)) {
          // Start initial timer
          startTimer(entityId, rule);

          // Subscribe to reset timer on matching events
          const unsub = self.on(entityId, (event) => {
            if (rule.expect && !rule.expect(event)) return;
            startTimer(entityId, rule);
          });
          unsubscribers.push(unsub);
        }

        const cleanup = () => {
          for (const unsub of unsubscribers) unsub();
          for (const [, t] of timers) clearTimeout(t);
          timers.clear();
        };
        handles.eventSubscriptions.push(cleanup);
        return cleanup;
      },
      invariant: (options: InvariantOptions) => {
        let stopped = false;
        const tick = async () => {
          if (stopped) return;
          try {
            const ok = await options.check();
            if (!ok && !stopped) {
              try { await options.violated(); } catch { /* swallow */ }
            }
          } catch { /* swallow check errors */ }
        };
        const timer = setInterval(tick, options.interval);
        const cleanup = () => {
          stopped = true;
          clearInterval(timer);
        };
        handles.eventSubscriptions.push(cleanup);
        return cleanup;
      },
    };
  }

  /**
   * Clean up all subscriptions, callbacks, and timers.
   */
  async destroy(): Promise<void> {
    // Clear all reaction timers
    for (const [, timer] of this.reactionTimers) {
      clearTimeout(timer);
    }
    this.reactionTimers.clear();
    this.entityCallbacks.clear();
    this.domainCallbacks.clear();
    this.stateCache.clear();

    // Unsubscribe from HA events
    if (this.subscriptionId !== null) {
      try {
        await this.wsClient.unsubscribeEvents(this.subscriptionId);
      } catch {
        // WS may already be disconnected
      }
      this.subscriptionId = null;
    }
  }
}

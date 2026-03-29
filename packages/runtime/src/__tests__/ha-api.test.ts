import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { HAWebSocketClient, HAEvent } from '../ws-client.js';
import type { EntityLogger } from '@ha-forge/sdk';
import { HAApiImpl } from '../ha-api.js';

function createMockLogger(): EntityLogger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

// ---- Mock WS Client ----

function createMockWSClient(): HAWebSocketClient & {
  sendCommand: ReturnType<typeof vi.fn>;
  subscribeEvents: ReturnType<typeof vi.fn>;
  unsubscribeEvents: ReturnType<typeof vi.fn>;
} {
  return {
    sendCommand: vi.fn(async () => null),
    subscribeEvents: vi.fn(async () => 42), // Returns subscription ID 42
    unsubscribeEvents: vi.fn(async () => {}),
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    isConnected: vi.fn(() => true),
    getHAVersion: vi.fn(() => '2024.1.0'),
  } as unknown as HAWebSocketClient & {
    sendCommand: ReturnType<typeof vi.fn>;
    subscribeEvents: ReturnType<typeof vi.fn>;
    unsubscribeEvents: ReturnType<typeof vi.fn>;
  };
}

function makeStateChangedEvent(
  entityId: string,
  oldState: string,
  newState: string,
  attributes?: Record<string, unknown>,
): HAEvent {
  return {
    event_type: 'state_changed',
    data: {
      entity_id: entityId,
      old_state: {
        entity_id: entityId,
        state: oldState,
        attributes: attributes ?? {},
        last_changed: '2024-01-15T10:00:00.000Z',
        last_updated: '2024-01-15T10:00:00.000Z',
        context: { id: 'ctx1', parent_id: null, user_id: null },
      },
      new_state: {
        entity_id: entityId,
        state: newState,
        attributes: attributes ?? {},
        last_changed: '2024-01-15T10:00:01.000Z',
        last_updated: '2024-01-15T10:00:01.000Z',
        context: { id: 'ctx2', parent_id: null, user_id: null },
      },
    } as unknown as Record<string, unknown>,
    time_fired: '2024-01-15T10:00:01.000Z',
    origin: 'LOCAL',
    context: { id: 'ctx2', parent_id: null, user_id: null },
  };
}

describe('HAApiImpl', () => {
  let wsClient: ReturnType<typeof createMockWSClient>;
  let api: HAApiImpl;

  beforeEach(async () => {
    wsClient = createMockWSClient();
    api = new HAApiImpl(wsClient, createMockLogger());
    await api.init();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await api.destroy();
  });

  describe('init()', () => {
    it('subscribes to state_changed events', () => {
      expect(wsClient.subscribeEvents).toHaveBeenCalledWith('state_changed');
    });
  });

  describe('on() — entity subscriptions', () => {
    it('dispatches state_changed events to entity callbacks', () => {
      const cb = vi.fn();
      api.on('light.living_room', cb);

      api.handleEvent(42, makeStateChangedEvent('light.living_room', 'off', 'on'));

      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb).toHaveBeenCalledWith(expect.objectContaining({
        entity_id: 'light.living_room',
        old_state: 'off',
        new_state: 'on',
      }));
    });

    it('does not dispatch events for non-matching entities', () => {
      const cb = vi.fn();
      api.on('light.living_room', cb);

      api.handleEvent(42, makeStateChangedEvent('light.bedroom', 'off', 'on'));

      expect(cb).not.toHaveBeenCalled();
    });

    it('returns an unsubscribe function', () => {
      const cb = vi.fn();
      const unsub = api.on('light.living_room', cb);

      unsub();
      api.handleEvent(42, makeStateChangedEvent('light.living_room', 'off', 'on'));

      expect(cb).not.toHaveBeenCalled();
    });

    it('supports multiple callbacks per entity', () => {
      const cb1 = vi.fn();
      const cb2 = vi.fn();
      api.on('light.living_room', cb1);
      api.on('light.living_room', cb2);

      api.handleEvent(42, makeStateChangedEvent('light.living_room', 'off', 'on'));

      expect(cb1).toHaveBeenCalledTimes(1);
      expect(cb2).toHaveBeenCalledTimes(1);
    });

    it('supports array of entity IDs', () => {
      const cb = vi.fn();
      api.on(['light.living_room', 'light.bedroom'], cb);

      api.handleEvent(42, makeStateChangedEvent('light.living_room', 'off', 'on'));
      api.handleEvent(42, makeStateChangedEvent('light.bedroom', 'on', 'off'));

      expect(cb).toHaveBeenCalledTimes(2);
    });
  });

  describe('on() — domain subscriptions', () => {
    it('dispatches events matching the domain', () => {
      const cb = vi.fn();
      api.on('light', cb);

      api.handleEvent(42, makeStateChangedEvent('light.living_room', 'off', 'on'));
      api.handleEvent(42, makeStateChangedEvent('light.bedroom', 'on', 'off'));
      api.handleEvent(42, makeStateChangedEvent('switch.pump', 'off', 'on'));

      expect(cb).toHaveBeenCalledTimes(2);
      expect(cb.mock.calls[0][0].entity_id).toBe('light.living_room');
      expect(cb.mock.calls[1][0].entity_id).toBe('light.bedroom');
    });
  });

  describe('on() — event ignores wrong subscription IDs', () => {
    it('ignores events from other subscriptions', () => {
      const cb = vi.fn();
      api.on('light.living_room', cb);

      // Wrong subscription ID
      api.handleEvent(999, makeStateChangedEvent('light.living_room', 'off', 'on'));

      expect(cb).not.toHaveBeenCalled();
    });
  });

  describe('callService()', () => {
    it('sends call_service command with correct fields', async () => {
      await api.callService('light.living_room', 'turn_on', { brightness: 200 });

      expect(wsClient.sendCommand).toHaveBeenCalledWith('call_service', {
        domain: 'light',
        service: 'turn_on',
        service_data: { brightness: 200 },
        target: { entity_id: 'light.living_room' },
        return_response: true,
      });
    });

    it('sends empty service_data when no data provided', async () => {
      await api.callService('switch.pump', 'turn_off');

      expect(wsClient.sendCommand).toHaveBeenCalledWith('call_service', {
        domain: 'switch',
        service: 'turn_off',
        service_data: {},
        target: { entity_id: 'switch.pump' },
        return_response: true,
      });
    });

    it('omits target for domain-only calls (no dot)', async () => {
      await api.callService('light', 'turn_on', { brightness: 255 });

      expect(wsClient.sendCommand).toHaveBeenCalledWith('call_service', {
        domain: 'light',
        service: 'turn_on',
        service_data: { brightness: 255 },
        return_response: true,
      });
      // Should NOT have target key at all
      const payload = wsClient.sendCommand.mock.calls[0][1] as Record<string, unknown>;
      expect(payload).not.toHaveProperty('target');
    });
  });

  describe('callService() — runtime validation', () => {
    it('validates parameters using generated validators before dispatch', async () => {
      const validators = {
        'light.turn_on': {
          brightness: (v: unknown) => {
            if (typeof v !== 'number' || v < 0 || v > 255) {
              throw new RangeError(`brightness must be 0-255, got ${v}`);
            }
            return v;
          },
        },
      };
      const validatedApi = new HAApiImpl(wsClient, createMockLogger(), validators);
      await validatedApi.init();

      // Valid call
      await validatedApi.callService('light.living_room', 'turn_on', { brightness: 200 });
      expect(wsClient.sendCommand).toHaveBeenCalled();

      // Invalid call — should throw before sending
      wsClient.sendCommand.mockClear();
      await expect(
        validatedApi.callService('light.living_room', 'turn_on', { brightness: 999 }),
      ).rejects.toThrow(RangeError);

      // sendCommand should NOT have been called for invalid data
      const callServiceCalls = wsClient.sendCommand.mock.calls.filter(
        (c: unknown[]) => c[0] === 'call_service',
      );
      expect(callServiceCalls).toHaveLength(0);

      await validatedApi.destroy();
    });

    it('skips validation for fields not present in data', async () => {
      const validators = {
        'light.turn_on': {
          brightness: vi.fn((v: unknown) => v),
        },
      };
      const validatedApi = new HAApiImpl(wsClient, createMockLogger(), validators);
      await validatedApi.init();

      // Call without brightness — validator should not be called
      await validatedApi.callService('light.living_room', 'turn_on', { transition: 5 });
      expect(validators['light.turn_on'].brightness).not.toHaveBeenCalled();

      await validatedApi.destroy();
    });

    it('skips validation when no validators configured', async () => {
      // Default api has no validators
      await api.callService('light.living_room', 'turn_on', { brightness: 999 });
      expect(wsClient.sendCommand).toHaveBeenCalled();
    });
  });

  describe('getState()', () => {
    it('fetches states via get_states and returns matching entity', async () => {
      wsClient.sendCommand.mockResolvedValueOnce([
        {
          entity_id: 'light.living_room',
          state: 'on',
          attributes: { brightness: 200 },
          last_changed: '2024-01-15T10:00:00.000Z',
          last_updated: '2024-01-15T10:00:01.000Z',
        },
        {
          entity_id: 'switch.pump',
          state: 'off',
          attributes: {},
          last_changed: '2024-01-15T09:00:00.000Z',
          last_updated: '2024-01-15T09:00:00.000Z',
        },
      ]);

      const result = await api.getState('light.living_room');

      expect(result).toEqual({
        state: 'on',
        attributes: { brightness: 200 },
        last_changed: '2024-01-15T10:00:00.000Z',
        last_updated: '2024-01-15T10:00:01.000Z',
      });
    });

    it('returns null for unknown entity', async () => {
      wsClient.sendCommand.mockResolvedValueOnce([]);

      const result = await api.getState('sensor.nonexistent');
      expect(result).toBeNull();
    });

    it('uses cached state from events', async () => {
      // Trigger a state event first to populate cache
      api.handleEvent(42, makeStateChangedEvent('light.living_room', 'off', 'on'));

      const result = await api.getState('light.living_room');

      // Should NOT have called sendCommand for get_states since it's cached
      expect(wsClient.sendCommand).not.toHaveBeenCalledWith('get_states');
      expect(result?.state).toBe('on');
    });
  });

  describe('getEntities()', () => {
    it('returns all entity IDs', async () => {
      wsClient.sendCommand.mockResolvedValueOnce([
        { entity_id: 'light.a', state: 'on', attributes: {} },
        { entity_id: 'light.b', state: 'off', attributes: {} },
        { entity_id: 'switch.c', state: 'on', attributes: {} },
      ]);

      const result = await api.getEntities();
      expect(result).toEqual(['light.a', 'light.b', 'switch.c']);
    });

    it('filters by domain', async () => {
      wsClient.sendCommand.mockResolvedValueOnce([
        { entity_id: 'light.a', state: 'on', attributes: {} },
        { entity_id: 'light.b', state: 'off', attributes: {} },
        { entity_id: 'switch.c', state: 'on', attributes: {} },
      ]);

      const result = await api.getEntities('light');
      expect(result).toEqual(['light.a', 'light.b']);
    });
  });

  describe('fireEvent()', () => {
    it('sends fire_event command', async () => {
      await api.fireEvent('custom_event', { device_id: 'abc' });

      expect(wsClient.sendCommand).toHaveBeenCalledWith('fire_event', {
        event_type: 'custom_event',
        event_data: { device_id: 'abc' },
      });
    });

    it('sends empty event_data when not provided', async () => {
      await api.fireEvent('ping');

      expect(wsClient.sendCommand).toHaveBeenCalledWith('fire_event', {
        event_type: 'ping',
        event_data: {},
      });
    });
  });

  describe('reactions()', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it('fires action when state matches "to" condition', () => {
      const action = vi.fn();
      api.reactions({
        'binary_sensor.front_door': {
          to: 'on',
          do: action,
        },
      });

      api.handleEvent(42, makeStateChangedEvent('binary_sensor.front_door', 'off', 'on'));
      expect(action).toHaveBeenCalledTimes(1);

      // Does not fire when state does not match
      api.handleEvent(42, makeStateChangedEvent('binary_sensor.front_door', 'on', 'off'));
      expect(action).toHaveBeenCalledTimes(1);
    });

    it('fires action when "when" condition returns true', () => {
      const action = vi.fn();
      api.reactions({
        'sensor.temperature': {
          when: (e) => Number(e.new_state) > 25,
          do: action,
        },
      });

      api.handleEvent(42, makeStateChangedEvent('sensor.temperature', '22', '28'));
      expect(action).toHaveBeenCalledTimes(1);

      api.handleEvent(42, makeStateChangedEvent('sensor.temperature', '28', '20'));
      expect(action).toHaveBeenCalledTimes(1); // "when" returns false for 20
    });

    it('delays action with "after" and cancels on state change', () => {
      const action = vi.fn();
      api.reactions({
        'switch.garage_door': {
          to: 'on',
          after: 5000,
          do: action,
        },
      });

      // Trigger the condition
      api.handleEvent(42, makeStateChangedEvent('switch.garage_door', 'off', 'on'));
      expect(action).not.toHaveBeenCalled();

      // State changes before timer fires → cancels the timer
      api.handleEvent(42, makeStateChangedEvent('switch.garage_door', 'on', 'off'));

      // Advance past the delay
      vi.advanceTimersByTime(6000);
      expect(action).not.toHaveBeenCalled();
    });

    it('executes delayed action after the delay', () => {
      const action = vi.fn();
      api.reactions({
        'switch.garage_door': {
          to: 'on',
          after: 5000,
          do: action,
        },
      });

      api.handleEvent(42, makeStateChangedEvent('switch.garage_door', 'off', 'on'));
      vi.advanceTimersByTime(5000);
      expect(action).toHaveBeenCalledTimes(1);
    });

    it('returns cleanup function that cancels pending timers', () => {
      const action = vi.fn();
      const cleanup = api.reactions({
        'switch.garage_door': {
          to: 'on',
          after: 5000,
          do: action,
        },
      });

      api.handleEvent(42, makeStateChangedEvent('switch.garage_door', 'off', 'on'));
      cleanup(); // Cancel everything

      vi.advanceTimersByTime(6000);
      expect(action).not.toHaveBeenCalled();
    });

    it('cleanup removes event listeners', () => {
      const action = vi.fn();
      const cleanup = api.reactions({
        'light.living_room': {
          to: 'on',
          do: action,
        },
      });

      cleanup();

      api.handleEvent(42, makeStateChangedEvent('light.living_room', 'off', 'on'));
      expect(action).not.toHaveBeenCalled();
    });
  });

  describe('asStateless()', () => {
    it('returns object with query/action methods but no subscriptions or log', () => {
      const stateless = api.asStateless();

      expect(typeof stateless.callService).toBe('function');
      expect(typeof stateless.getState).toBe('function');
      expect(typeof stateless.getEntities).toBe('function');
      expect(typeof stateless.fireEvent).toBe('function');
      expect(typeof stateless.friendlyName).toBe('function');
      // Should not have on(), reactions(), or log
      expect((stateless as unknown as Record<string, unknown>).on).toBeUndefined();
      expect((stateless as unknown as Record<string, unknown>).reactions).toBeUndefined();
      expect((stateless as unknown as Record<string, unknown>).log).toBeUndefined();
    });

    it('delegates callService to the underlying API', async () => {
      const stateless = api.asStateless();
      await stateless.callService('light.test', 'turn_on', { brightness: 100 });

      expect(wsClient.sendCommand).toHaveBeenCalledWith('call_service', expect.objectContaining({
        domain: 'light',
        service: 'turn_on',
      }));
    });
  });

  describe('createScopedEvents()', () => {
    it('tracks stream().subscribe() unsubscribers in handles', () => {
      const handles = { eventSubscriptions: [] as Array<() => void> };
      const events = api.createScopedEvents(handles);

      events.stream('light.living_room').subscribe(vi.fn());

      expect(handles.eventSubscriptions).toHaveLength(1);
      expect(typeof handles.eventSubscriptions[0]).toBe('function');
    });

    it('tracks reactions() unsubscribers in handles', () => {
      const handles = { eventSubscriptions: [] as Array<() => void> };
      const events = api.createScopedEvents(handles);

      events.reactions({ 'light.test': { to: 'on', do: vi.fn() } });

      expect(handles.eventSubscriptions).toHaveLength(1);
    });

    it('unsubscribes stream().subscribe() callbacks when handle cleanup is called', () => {
      const handles = { eventSubscriptions: [] as Array<() => void> };
      const events = api.createScopedEvents(handles);
      const cb = vi.fn();

      events.stream('light.living_room').subscribe(cb);

      // Clean up
      for (const unsub of handles.eventSubscriptions) unsub();

      // Should not fire after cleanup
      api.handleEvent(42, makeStateChangedEvent('light.living_room', 'off', 'on'));
      expect(cb).not.toHaveBeenCalled();
    });
  });

  describe('destroy()', () => {
    it('unsubscribes from HA events', async () => {
      await api.destroy();
      expect(wsClient.unsubscribeEvents).toHaveBeenCalledWith(42);
    });

    it('clears all callbacks', async () => {
      const cb = vi.fn();
      api.on('light.test', cb);

      await api.destroy();

      // Re-init to get a new subscription
      await api.init();
      api.handleEvent(42, makeStateChangedEvent('light.test', 'off', 'on'));
      expect(cb).not.toHaveBeenCalled();
    });
  });

  describe('friendlyName', () => {
    it('returns friendly_name from cached state', () => {
      // Populate cache via handleEvent
      api.handleEvent(42, makeStateChangedEvent('light.kitchen', 'off', 'on', {
        friendly_name: 'Kitchen Light',
      }));
      expect(api.friendlyName('light.kitchen')).toBe('Kitchen Light');
    });

    it('returns entity ID when not in cache', () => {
      expect(api.friendlyName('sensor.unknown')).toBe('sensor.unknown');
    });

    it('returns entity ID when friendly_name attribute missing', () => {
      api.handleEvent(42, makeStateChangedEvent('sensor.bare', 'off', 'on', {}));
      expect(api.friendlyName('sensor.bare')).toBe('sensor.bare');
    });
  });

  // ---- History API ----

  describe('history', () => {
    function makeHistoryResponse(entries: Array<{ state: string; last_changed: string }>): Response {
      return new Response(JSON.stringify([entries]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    function createApiWithHttp(httpFetch: (path: string) => Promise<Response>) {
      const l = createMockLogger();
      const a = new HAApiImpl(wsClient, l, undefined, httpFetch);
      return { api: a, logger: l };
    }

    describe('recentlyIn()', () => {
      it('returns true when entity was in the given state within the window', async () => {
        const now = Date.now();
        const httpFetch = vi.fn(async () => makeHistoryResponse([
          { state: 'home', last_changed: new Date(now - 30_000).toISOString() },
          { state: 'away', last_changed: new Date(now - 10_000).toISOString() },
        ]));
        const { api: a } = createApiWithHttp(httpFetch);

        expect(await a.historyRecentlyIn('person.alice', 'home', { within: 60_000 })).toBe(true);
        expect(httpFetch).toHaveBeenCalledOnce();
      });

      it('returns false when entity was never in the given state', async () => {
        const httpFetch = vi.fn(async () => makeHistoryResponse([
          { state: 'away', last_changed: new Date().toISOString() },
        ]));
        const { api: a } = createApiWithHttp(httpFetch);

        expect(await a.historyRecentlyIn('person.alice', 'home', { within: 60_000 })).toBe(false);
      });

      it('returns false when no history data', async () => {
        const httpFetch = vi.fn(async () => makeHistoryResponse([]));
        const { api: a } = createApiWithHttp(httpFetch);

        expect(await a.historyRecentlyIn('person.alice', 'home', { within: 60_000 })).toBe(false);
      });
    });

    describe('average()', () => {
      it('computes time-weighted average of numeric states', async () => {
        const now = Date.now();
        const httpFetch = vi.fn(async () => makeHistoryResponse([
          { state: '20', last_changed: new Date(now - 60_000).toISOString() },
          { state: '30', last_changed: new Date(now - 30_000).toISOString() },
        ]));
        const { api: a } = createApiWithHttp(httpFetch);

        const result = await a.historyAverage('sensor.temp', { over: 60_000 });
        // 20 for ~30s, 30 for ~30s → ~25
        expect(result).toBeCloseTo(25, 0);
      });

      it('returns null when no data', async () => {
        const httpFetch = vi.fn(async () => makeHistoryResponse([]));
        const { api: a } = createApiWithHttp(httpFetch);

        expect(await a.historyAverage('sensor.temp', { over: 60_000 })).toBeNull();
      });

      it('returns null when all states are non-numeric', async () => {
        const httpFetch = vi.fn(async () => makeHistoryResponse([
          { state: 'unavailable', last_changed: new Date().toISOString() },
        ]));
        const { api: a } = createApiWithHttp(httpFetch);

        expect(await a.historyAverage('sensor.temp', { over: 60_000 })).toBeNull();
      });
    });

    describe('countTransitions()', () => {
      it('counts all state transitions', async () => {
        const now = Date.now();
        const httpFetch = vi.fn(async () => makeHistoryResponse([
          { state: 'off', last_changed: new Date(now - 60_000).toISOString() },
          { state: 'on', last_changed: new Date(now - 40_000).toISOString() },
          { state: 'off', last_changed: new Date(now - 20_000).toISOString() },
          { state: 'on', last_changed: new Date(now - 10_000).toISOString() },
        ]));
        const { api: a } = createApiWithHttp(httpFetch);

        expect(await a.historyCountTransitions('light.hall', { over: 60_000 })).toBe(3);
      });

      it('counts only transitions to a specific state', async () => {
        const now = Date.now();
        const httpFetch = vi.fn(async () => makeHistoryResponse([
          { state: 'off', last_changed: new Date(now - 60_000).toISOString() },
          { state: 'on', last_changed: new Date(now - 40_000).toISOString() },
          { state: 'off', last_changed: new Date(now - 20_000).toISOString() },
          { state: 'on', last_changed: new Date(now - 10_000).toISOString() },
        ]));
        const { api: a } = createApiWithHttp(httpFetch);

        expect(await a.historyCountTransitions('light.hall', { to: 'on', over: 60_000 })).toBe(2);
      });

      it('returns 0 with fewer than 2 entries', async () => {
        const httpFetch = vi.fn(async () => makeHistoryResponse([
          { state: 'on', last_changed: new Date().toISOString() },
        ]));
        const { api: a } = createApiWithHttp(httpFetch);

        expect(await a.historyCountTransitions('light.hall', { over: 60_000 })).toBe(0);
      });
    });

    describe('duration()', () => {
      it('computes total time in a given state', async () => {
        const now = Date.now();
        const httpFetch = vi.fn(async () => makeHistoryResponse([
          { state: 'on', last_changed: new Date(now - 60_000).toISOString() },
          { state: 'off', last_changed: new Date(now - 40_000).toISOString() },
          { state: 'on', last_changed: new Date(now - 10_000).toISOString() },
        ]));
        const { api: a } = createApiWithHttp(httpFetch);

        const result = await a.historyDuration('light.hall', 'on', { over: 60_000 });
        // on for 20s (60k-40k), off for 30s (40k-10k), on for ~10s (10k-now) → ~30s on
        expect(result).toBeGreaterThan(29_000);
        expect(result).toBeLessThan(31_000);
      });

      it('returns 0 when entity was never in the given state', async () => {
        const now = Date.now();
        const httpFetch = vi.fn(async () => makeHistoryResponse([
          { state: 'off', last_changed: new Date(now - 60_000).toISOString() },
        ]));
        const { api: a } = createApiWithHttp(httpFetch);

        expect(await a.historyDuration('light.hall', 'on', { over: 60_000 })).toBe(0);
      });

      it('returns 0 when no history data', async () => {
        const httpFetch = vi.fn(async () => makeHistoryResponse([]));
        const { api: a } = createApiWithHttp(httpFetch);

        expect(await a.historyDuration('light.hall', 'on', { over: 60_000 })).toBe(0);
      });
    });

    describe('no httpFetch configured', () => {
      it('returns safe defaults and logs warning', async () => {
        const l = createMockLogger();
        const a = new HAApiImpl(wsClient, l);

        expect(await a.historyRecentlyIn('person.alice', 'home', { within: 60_000 })).toBe(false);
        expect(await a.historyAverage('sensor.temp', { over: 60_000 })).toBeNull();
        expect(await a.historyCountTransitions('light.hall', { over: 60_000 })).toBe(0);
        expect(await a.historyDuration('light.hall', 'on', { over: 60_000 })).toBe(0);
        expect(l.warn).toHaveBeenCalled();
      });
    });

    describe('HTTP error handling', () => {
      it('returns safe defaults on HTTP error', async () => {
        const httpFetch = vi.fn(async () => new Response(null, { status: 500 }));
        const { api: a, logger: l } = createApiWithHttp(httpFetch);

        expect(await a.historyRecentlyIn('person.alice', 'home', { within: 60_000 })).toBe(false);
        expect(l.warn).toHaveBeenCalledWith(expect.stringContaining('500'));
      });
    });

    describe('asStateless() includes history', () => {
      it('exposes history methods on stateless API', () => {
        const stateless = api.asStateless();
        expect(stateless.history).toBeDefined();
        expect(typeof stateless.history.recentlyIn).toBe('function');
        expect(typeof stateless.history.average).toBe('function');
        expect(typeof stateless.history.countTransitions).toBe('function');
        expect(typeof stateless.history.duration).toBe('function');
      });
    });
  });
});

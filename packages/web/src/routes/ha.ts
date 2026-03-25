import { Hono } from 'hono';

export type FetchFromHA = (path: string) => Promise<Response>;

export interface HARouteOptions {
  fetchFromHA: FetchFromHA;
}

export function createHARoutes(opts: HARouteOptions) {
  const app = new Hono();

  // GET /states — all HA entity states (for entity picker, future uses)
  app.get('/states', async (c) => {
    try {
      const resp = await opts.fetchFromHA('/states');
      if (!resp.ok) {
        return c.json({ error: `HA API returned ${resp.status}` }, 502);
      }
      const states = await resp.json();
      return c.json(states);
    } catch (err) {
      return c.json({ error: 'Failed to fetch HA states' }, 500);
    }
  });

  // GET /history?entity_id=...&start=...&end=... — proxies HA history API
  app.get('/history', async (c) => {
    const entityId = c.req.query('entity_id');
    const start = c.req.query('start');
    const end = c.req.query('end');

    if (!entityId || !start || !end) {
      return c.json({ error: 'Missing required query parameters: entity_id, start, end' }, 400);
    }

    try {
      const haPath = `/history/period/${encodeURIComponent(start)}?end_time=${encodeURIComponent(end)}&filter_entity_id=${encodeURIComponent(entityId)}&minimal_response&no_attributes`;
      const resp = await opts.fetchFromHA(haPath);
      if (!resp.ok) {
        return c.json({ error: `HA API returned ${resp.status}` }, 502);
      }
      const history = await resp.json();
      return c.json(history);
    } catch (err) {
      return c.json({ error: 'Failed to fetch HA history' }, 500);
    }
  });

  return app;
}

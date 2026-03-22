import { Hono } from 'hono';

export interface EntityInfo {
  id: string;
  name: string;
  type: string;
  state: unknown;
  sourceFile: string;
  status: 'healthy' | 'error' | 'unavailable';
  unit_of_measurement?: string;
}

export type GetEntitiesFn = () => EntityInfo[];

export function createEntitiesRoutes(getEntities: GetEntitiesFn) {
  const app = new Hono();

  app.get('/', (c) => {
    return c.json({ entities: getEntities() });
  });

  return app;
}

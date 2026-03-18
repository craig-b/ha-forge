import { Hono } from 'hono';

export interface LogEntry {
  id?: number;
  timestamp: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  entity_id: string | null;
  source_file: string | null;
  message: string;
  data: string | null;
}

export type QueryLogsFn = (opts: {
  entity_id?: string;
  level?: string[];
  source_file?: string;
  since?: number;
  until?: number;
  search?: string;
  limit?: number;
  offset?: number;
}) => LogEntry[];

export function createLogsRoutes(queryLogs: QueryLogsFn) {
  const app = new Hono();

  app.get('/', (c) => {
    const params = c.req.query();

    const level = params.level?.split(',').filter(Boolean);
    const since = params.since ? parseInt(params.since, 10) : undefined;
    const until = params.until ? parseInt(params.until, 10) : undefined;
    const limit = params.limit ? parseInt(params.limit, 10) : 100;
    const offset = params.offset ? parseInt(params.offset, 10) : 0;

    const logs = queryLogs({
      entity_id: params.entity_id,
      level,
      source_file: params.source_file,
      since,
      until,
      search: params.search,
      limit,
      offset,
    });

    return c.json({ logs, count: logs.length });
  });

  return app;
}

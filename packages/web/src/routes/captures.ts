import { Hono } from 'hono';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface CapturesRouteOptions {
  capturesDir: string;
}

interface CaptureFile {
  entity_id: string;
  name: string;
  start: string;
  end: string;
  captured_at: string;
  events: Array<{ t: number; value: string | number }>;
}

/** Resolve path safely, preventing directory traversal */
function resolveSafe(baseDir: string, relativePath: string): string | null {
  const resolved = path.resolve(baseDir, relativePath);
  if (!resolved.startsWith(path.resolve(baseDir) + path.sep) && resolved !== path.resolve(baseDir)) {
    return null;
  }
  return resolved;
}

export function createCapturesRoutes(opts: CapturesRouteOptions) {
  const app = new Hono();

  // GET / — list captures (metadata only, no events array)
  app.get('/', (c) => {
    try {
      fs.mkdirSync(opts.capturesDir, { recursive: true });
      const files = fs.readdirSync(opts.capturesDir).filter(f => f.endsWith('.json'));
      const captures = [];
      for (const file of files) {
        try {
          const fullPath = path.join(opts.capturesDir, file);
          const raw = fs.readFileSync(fullPath, 'utf-8');
          const data = JSON.parse(raw) as CaptureFile;
          captures.push({
            entity_id: data.entity_id,
            name: data.name,
            start: data.start,
            end: data.end,
            captured_at: data.captured_at,
            eventCount: data.events?.length ?? 0,
            filename: file,
          });
        } catch {
          // Skip malformed files
        }
      }
      return c.json({ captures });
    } catch (err) {
      return c.json({ error: 'Failed to list captures' }, 500);
    }
  });

  // GET /:name — full capture JSON including events
  app.get('/:name', (c) => {
    const name = c.req.param('name');
    const fullPath = resolveSafe(opts.capturesDir, name.endsWith('.json') ? name : `${name}.json`);
    if (!fullPath) {
      return c.json({ error: 'Invalid path' }, 400);
    }

    try {
      if (!fs.existsSync(fullPath)) {
        // Search by capture name field
        const files = fs.readdirSync(opts.capturesDir).filter(f => f.endsWith('.json'));
        for (const file of files) {
          try {
            const fp = path.join(opts.capturesDir, file);
            const raw = fs.readFileSync(fp, 'utf-8');
            const data = JSON.parse(raw) as CaptureFile;
            if (data.name === name) {
              return c.json(data);
            }
          } catch {
            // Skip malformed files
          }
        }
        return c.json({ error: 'Capture not found' }, 404);
      }
      const data = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
      return c.json(data);
    } catch (err) {
      return c.json({ error: 'Failed to read capture' }, 500);
    }
  });

  // POST / — save new capture
  app.post('/', async (c) => {
    try {
      const body = await c.req.json<{
        entity_id: string;
        name: string;
        start: string;
        end: string;
        events: Array<{ t: number; value: string | number }>;
      }>();

      if (!body.entity_id || !body.name || !body.start || !body.end || !Array.isArray(body.events)) {
        return c.json({ error: 'Missing required fields: entity_id, name, start, end, events' }, 400);
      }

      // Sanitize name for use in lookup (no path separators)
      if (body.name.includes('/') || body.name.includes('\\') || body.name.includes('..')) {
        return c.json({ error: 'Invalid capture name' }, 400);
      }

      fs.mkdirSync(opts.capturesDir, { recursive: true });

      const capture: CaptureFile = {
        entity_id: body.entity_id,
        name: body.name,
        start: body.start,
        end: body.end,
        captured_at: new Date().toISOString(),
        events: body.events,
      };

      // Generate filename from entity_id and date range
      const startDate = body.start.split('T')[0];
      const endDate = body.end.split('T')[0];
      const filename = `${body.entity_id}_${startDate}_${endDate}.json`;

      const fullPath = resolveSafe(opts.capturesDir, filename);
      if (!fullPath) {
        return c.json({ error: 'Invalid filename' }, 400);
      }

      fs.writeFileSync(fullPath, JSON.stringify(capture, null, 2), 'utf-8');
      return c.json({ success: true, filename });
    } catch (err) {
      return c.json({ error: 'Failed to save capture' }, 500);
    }
  });

  return app;
}

import { Hono } from 'hono';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { GitService } from '@ha-forge/runtime';

export interface FilesRouteOptions {
  scriptsDir: string;
  gitService?: GitService;
}

export function createFilesRoutes(opts: FilesRouteOptions) {
  const app = new Hono();

  // List files in scripts directory
  app.get('/', (c) => {
    try {
      const files = listFiles(opts.scriptsDir, opts.scriptsDir);
      return c.json({ files });
    } catch (err) {
      return c.json({ error: 'Failed to list files' }, 500);
    }
  });

  // Read file contents
  app.get('/:path{.+}', (c) => {
    const filePath = c.req.param('path');
    const fullPath = resolveSafe(opts.scriptsDir, filePath);
    if (!fullPath) {
      return c.json({ error: 'Invalid path' }, 400);
    }

    try {
      if (!fs.existsSync(fullPath)) {
        return c.json({ error: 'File not found' }, 404);
      }
      const content = fs.readFileSync(fullPath, 'utf-8');
      return c.json({ path: filePath, content });
    } catch (err) {
      return c.json({ error: 'Failed to read file' }, 500);
    }
  });

  // Write file contents
  app.put('/:path{.+}', async (c) => {
    const filePath = c.req.param('path');
    const fullPath = resolveSafe(opts.scriptsDir, filePath);
    if (!fullPath) {
      return c.json({ error: 'Invalid path' }, 400);
    }

    try {
      const body = await c.req.json<{ content: string }>();
      if (typeof body.content !== 'string') {
        return c.json({ error: 'Missing content field' }, 400);
      }

      // Ensure parent directory exists
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, body.content, 'utf-8');

      // Auto-commit to git (fire-and-forget)
      if (opts.gitService) {
        const sidecar = fullPath.replace(/\.ts$/, '.package.json');
        opts.gitService.commitFile(fullPath, sidecar).catch((err) => console.error('[git]', err instanceof Error ? err.message : err));
      }

      return c.json({ success: true, path: filePath });
    } catch (err) {
      return c.json({ error: 'Failed to write file' }, 500);
    }
  });

  // Rename/move file
  app.patch('/:path{.+}', async (c) => {
    const filePath = c.req.param('path');
    const fullPath = resolveSafe(opts.scriptsDir, filePath);
    if (!fullPath) {
      return c.json({ error: 'Invalid path' }, 400);
    }

    try {
      const body = await c.req.json<{ newPath: string }>();
      if (typeof body.newPath !== 'string') {
        return c.json({ error: 'Missing newPath field' }, 400);
      }
      const newFullPath = resolveSafe(opts.scriptsDir, body.newPath);
      if (!newFullPath) {
        return c.json({ error: 'Invalid new path' }, 400);
      }
      if (!fs.existsSync(fullPath)) {
        return c.json({ error: 'File not found' }, 404);
      }
      if (fs.existsSync(newFullPath)) {
        return c.json({ error: 'Target file already exists' }, 409);
      }
      fs.mkdirSync(path.dirname(newFullPath), { recursive: true });
      fs.renameSync(fullPath, newFullPath);

      // Rename sidecar if it exists
      const oldSidecar = fullPath.replace(/\.ts$/, '.package.json');
      const newSidecar = newFullPath.replace(/\.ts$/, '.package.json');
      if (fs.existsSync(oldSidecar)) {
        fs.renameSync(oldSidecar, newSidecar);
      }

      // Auto-commit rename to git (fire-and-forget)
      if (opts.gitService) {
        opts.gitService.commitRename(
          fullPath, newFullPath,
          oldSidecar, fs.existsSync(newSidecar) ? newSidecar : undefined,
        ).catch((err) => console.error('[git]', err instanceof Error ? err.message : err));
      }

      return c.json({ success: true, path: body.newPath });
    } catch (err) {
      return c.json({ error: 'Failed to rename file' }, 500);
    }
  });

  // Delete file
  app.delete('/:path{.+}', (c) => {
    const filePath = c.req.param('path');
    const fullPath = resolveSafe(opts.scriptsDir, filePath);
    if (!fullPath) {
      return c.json({ error: 'Invalid path' }, 400);
    }

    try {
      if (!fs.existsSync(fullPath)) {
        return c.json({ error: 'File not found' }, 404);
      }
      fs.unlinkSync(fullPath);

      // Delete sidecar if it exists
      const sidecar = fullPath.replace(/\.ts$/, '.package.json');
      if (fs.existsSync(sidecar)) {
        fs.unlinkSync(sidecar);
      }

      // Auto-commit deletion to git (fire-and-forget)
      if (opts.gitService) {
        opts.gitService.commitDelete(fullPath, sidecar).catch((err) => console.error('[git]', err instanceof Error ? err.message : err));
      }

      return c.json({ success: true });
    } catch (err) {
      return c.json({ error: 'Failed to delete file' }, 500);
    }
  });

  return app;
}

/** Resolve path safely, preventing directory traversal */
function resolveSafe(baseDir: string, relativePath: string): string | null {
  const resolved = path.resolve(baseDir, relativePath);
  if (!resolved.startsWith(path.resolve(baseDir) + path.sep) && resolved !== path.resolve(baseDir)) {
    return null;
  }
  return resolved;
}

interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileEntry[];
}

function listFiles(dir: string, baseDir: string): FileEntry[] {
  if (!fs.existsSync(dir)) return [];

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const result: FileEntry[] = [];

  for (const entry of entries) {
    // Skip node_modules, hidden directories, and sidecar package files
    if (entry.name === 'node_modules' || entry.name.startsWith('.') || entry.name.endsWith('.package.json')) {
      continue;
    }

    const fullPath = path.join(dir, entry.name);
    const relativePath = path.relative(baseDir, fullPath);

    if (entry.isDirectory()) {
      result.push({
        name: entry.name,
        path: relativePath,
        type: 'directory',
        children: listFiles(fullPath, baseDir),
      });
    } else {
      result.push({
        name: entry.name,
        path: relativePath,
        type: 'file',
      });
    }
  }

  return result.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

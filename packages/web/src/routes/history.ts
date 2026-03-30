import { Hono } from 'hono';
import * as path from 'node:path';
import type { GitService, CommitInfo, DeployManifestManager } from '@ha-forge/runtime';

export interface HistoryRouteOptions {
  scriptsDir: string;
  gitService: GitService;
  manifestManager: DeployManifestManager;
}

export interface HistoryEntry extends CommitInfo {
  deployed: boolean;
}

export function createHistoryRoutes(opts: HistoryRouteOptions) {
  const app = new Hono();

  // Get commit history for a file
  app.get('/:path{.+}', async (c) => {
    const filePath = c.req.param('path');
    const limitParam = c.req.query('limit');
    const limit = limitParam ? parseInt(limitParam, 10) : 50;

    // Check for :sha suffix pattern — /api/history/file.ts/abc123
    const parts = filePath.split('/');
    const lastPart = parts[parts.length - 1];

    // If last part looks like a SHA (hex, 7-40 chars), treat as content-at-commit request
    if (/^[0-9a-f]{7,40}$/.test(lastPart) && parts.length >= 2) {
      const sha = lastPart;
      const file = parts.slice(0, -1).join('/');
      const fullPath = path.join(opts.scriptsDir, file);
      try {
        const content = await opts.gitService.getFileAtCommit(sha, fullPath);
        if (content === null) {
          return c.json({ error: 'File not found at commit' }, 404);
        }
        return c.json({ path: file, sha, content });
      } catch (err) {
        return c.json({ error: 'Failed to read file at commit' }, 500);
      }
    }

    // Otherwise, return commit history
    const fullPath = path.join(opts.scriptsDir, filePath);
    try {
      const commits = await opts.gitService.getFileHistory(fullPath, limit);
      const deployEntry = opts.manifestManager.getFile(filePath);
      const deployedCommit = deployEntry?.commit;

      const entries: HistoryEntry[] = commits.map((c) => ({
        ...c,
        deployed: c.sha === deployedCommit,
      }));

      return c.json({ path: filePath, history: entries });
    } catch (err) {
      return c.json({ error: 'Failed to get history' }, 500);
    }
  });

  return app;
}

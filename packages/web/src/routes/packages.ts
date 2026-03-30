import { Hono } from 'hono';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface PackagesRouteOptions {
  scriptsDir: string;
}

export function createPackagesRoutes(opts: PackagesRouteOptions) {
  const app = new Hono();
  const globalPackageJsonPath = path.join(opts.scriptsDir, 'package.json');

  /** Resolve the package.json path — either per-file sidecar or global. */
  function resolvePackageJsonPath(c: { req: { query: (key: string) => string | undefined } }): string {
    const file = c.req.query('file');
    if (file) {
      // Per-file sidecar: lights.ts → lights.package.json
      const sidecarName = file.replace(/\.ts$/, '.package.json');
      return path.join(opts.scriptsDir, sidecarName);
    }
    return globalPackageJsonPath;
  }

  // List installed packages
  app.get('/', (c) => {
    try {
      const pkgPath = resolvePackageJsonPath(c);
      const pkg = readPackageJson(pkgPath);
      return c.json({
        dependencies: pkg.dependencies ?? {},
        devDependencies: pkg.devDependencies ?? {},
      });
    } catch {
      return c.json({ dependencies: {}, devDependencies: {} });
    }
  });

  // Add package
  app.post('/', async (c) => {
    try {
      const body = await c.req.json<{ name: string; version?: string; dev?: boolean }>();
      if (!body.name || typeof body.name !== 'string') {
        return c.json({ error: 'Missing package name' }, 400);
      }

      const pkgPath = resolvePackageJsonPath(c);
      const pkg = readPackageJson(pkgPath);
      const version = body.version ?? 'latest';
      const depKey = body.dev ? 'devDependencies' : 'dependencies';

      if (!pkg[depKey]) pkg[depKey] = {};
      (pkg[depKey] as Record<string, string>)[body.name] = version;

      writePackageJson(pkgPath, pkg);
      return c.json({ success: true, name: body.name, version });
    } catch (err) {
      return c.json({ error: 'Failed to add package' }, 500);
    }
  });

  // Remove package
  app.delete('/:name', (c) => {
    try {
      const name = c.req.param('name');
      const pkgPath = resolvePackageJsonPath(c);
      const pkg = readPackageJson(pkgPath);

      let found = false;
      for (const key of ['dependencies', 'devDependencies'] as const) {
        if (pkg[key] && name in (pkg[key] as Record<string, unknown>)) {
          delete (pkg[key] as Record<string, unknown>)[name];
          found = true;
        }
      }

      if (!found) {
        return c.json({ error: 'Package not found' }, 404);
      }

      writePackageJson(pkgPath, pkg);
      return c.json({ success: true });
    } catch (err) {
      return c.json({ error: 'Failed to remove package' }, 500);
    }
  });

  return app;
}

function readPackageJson(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) {
    return { name: 'user-scripts', version: '1.0.0', dependencies: {} };
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function writePackageJson(filePath: string, pkg: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');
}

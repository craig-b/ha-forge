import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createServer } from '../server.js';
import { WSHub } from '../ws-hub.js';
import { generateUIHtml } from '../ui/index.js';
import type { WebServerConfig } from '../server.js';
import type { EntityInfo } from '../routes/entities.js';
import type { LogEntry } from '../routes/logs.js';

// ---- Test helpers ----

function createTestConfig(overrides: Partial<WebServerConfig> = {}): WebServerConfig {
  return {
    scriptsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'web-test-scripts-')),
    generatedDir: fs.mkdtempSync(path.join(os.tmpdir(), 'web-test-gen-')),
    triggerBuild: vi.fn(async () => ({
      building: false,
      lastBuild: {
        success: true,
        timestamp: new Date().toISOString(),
        totalDuration: 500,
        steps: [
          { step: 'bundle', success: true, duration: 200 },
        ],
        typeErrors: 0,
        bundleErrors: 0,
        entityCount: 2,
      },
    })),
    getBuildStatus: vi.fn(() => ({
      building: false,
      lastBuild: null,
    })),
    getEntities: vi.fn(() => []),
    queryLogs: vi.fn(() => []),
    regenerateTypes: vi.fn(async () => ({
      success: true,
      entityCount: 5,
      serviceCount: 10,
      errors: [],
    })),
    ...overrides,
  };
}

describe('Web server', () => {
  let config: WebServerConfig;

  beforeEach(() => {
    config = createTestConfig();
  });

  afterEach(() => {
    fs.rmSync(config.scriptsDir, { recursive: true, force: true });
    fs.rmSync(config.generatedDir, { recursive: true, force: true });
  });

  it('creates server with app and wsHub', () => {
    const { app, wsHub } = createServer(config);
    expect(app).toBeDefined();
    expect(wsHub).toBeInstanceOf(WSHub);
  });

  it('serves UI at root', async () => {
    const { app } = createServer(config);
    const res = await app.request('/');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('TS Entities');
    expect(html).toContain('monaco-editor');
  });

  it('passes ingress path to UI', async () => {
    const { app } = createServer(config);
    const res = await app.request('/', {
      headers: { 'x-ingress-path': '/api/hassio_ingress/abc123' },
    });
    const html = await res.text();
    expect(html).toContain('/api/hassio_ingress/abc123');
  });
});

describe('File API', () => {
  let config: WebServerConfig;

  beforeEach(() => {
    config = createTestConfig();
  });

  afterEach(() => {
    fs.rmSync(config.scriptsDir, { recursive: true, force: true });
    fs.rmSync(config.generatedDir, { recursive: true, force: true });
  });

  it('GET /api/files lists files', async () => {
    fs.writeFileSync(path.join(config.scriptsDir, 'test.ts'), 'export const x = 1;');
    const { app } = createServer(config);

    const res = await app.request('/api/files');
    const data = await res.json() as { files: Array<{ name: string; type: string }> };

    expect(data.files).toHaveLength(1);
    expect(data.files[0].name).toBe('test.ts');
    expect(data.files[0].type).toBe('file');
  });

  it('GET /api/files hides node_modules', async () => {
    fs.mkdirSync(path.join(config.scriptsDir, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(config.scriptsDir, 'node_modules', 'pkg.js'), '');
    fs.writeFileSync(path.join(config.scriptsDir, 'app.ts'), '');

    const { app } = createServer(config);
    const res = await app.request('/api/files');
    const data = await res.json() as { files: Array<{ name: string }> };

    expect(data.files).toHaveLength(1);
    expect(data.files[0].name).toBe('app.ts');
  });

  it('GET /api/files/:path reads file content', async () => {
    fs.writeFileSync(path.join(config.scriptsDir, 'hello.ts'), 'const x = 42;');
    const { app } = createServer(config);

    const res = await app.request('/api/files/hello.ts');
    const data = await res.json() as { path: string; content: string };

    expect(data.content).toBe('const x = 42;');
    expect(data.path).toBe('hello.ts');
  });

  it('GET /api/files/:path returns 404 for missing files', async () => {
    const { app } = createServer(config);
    const res = await app.request('/api/files/nonexistent.ts');
    expect(res.status).toBe(404);
  });

  it('PUT /api/files/:path writes file content', async () => {
    const { app } = createServer(config);

    const res = await app.request('/api/files/new.ts', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'export const y = 1;' }),
    });

    const data = await res.json() as { success: boolean };
    expect(data.success).toBe(true);
    expect(fs.readFileSync(path.join(config.scriptsDir, 'new.ts'), 'utf-8')).toBe('export const y = 1;');
  });

  it('DELETE /api/files/:path deletes file', async () => {
    fs.writeFileSync(path.join(config.scriptsDir, 'delete-me.ts'), 'gone');
    const { app } = createServer(config);

    const res = await app.request('/api/files/delete-me.ts', { method: 'DELETE' });
    const data = await res.json() as { success: boolean };

    expect(data.success).toBe(true);
    expect(fs.existsSync(path.join(config.scriptsDir, 'delete-me.ts'))).toBe(false);
  });

  it('rejects directory traversal', async () => {
    const { app } = createServer(config);
    const res = await app.request('/api/files/../../etc/passwd');
    // Hono normalizes the URL, so the traversal gets resolved.
    // Either 400 (path check) or 404 (file not found) is safe.
    expect([400, 404]).toContain(res.status);
  });
});

describe('Build API', () => {
  it('POST /api/build triggers build', async () => {
    const config = createTestConfig();
    const { app } = createServer(config);

    const res = await app.request('/api/build', { method: 'POST' });
    const data = await res.json() as { lastBuild: { success: boolean } };

    expect(config.triggerBuild).toHaveBeenCalled();
    expect(data.lastBuild.success).toBe(true);

    fs.rmSync(config.scriptsDir, { recursive: true, force: true });
    fs.rmSync(config.generatedDir, { recursive: true, force: true });
  });

  it('GET /api/build/status returns status', async () => {
    const config = createTestConfig();
    const { app } = createServer(config);

    const res = await app.request('/api/build/status');
    const data = await res.json() as { building: boolean };

    expect(data.building).toBe(false);

    fs.rmSync(config.scriptsDir, { recursive: true, force: true });
    fs.rmSync(config.generatedDir, { recursive: true, force: true });
  });
});

describe('Entities API', () => {
  it('GET /api/entities returns entity list', async () => {
    const entities: EntityInfo[] = [
      { id: 'sensor.temp', name: 'Temp', type: 'sensor', state: 22.5, sourceFile: 'weather.ts', status: 'healthy' },
    ];
    const config = createTestConfig({ getEntities: vi.fn(() => entities) });
    const { app } = createServer(config);

    const res = await app.request('/api/entities');
    const data = await res.json() as { entities: EntityInfo[] };

    expect(data.entities).toHaveLength(1);
    expect(data.entities[0].id).toBe('sensor.temp');
    expect(data.entities[0].state).toBe(22.5);

    fs.rmSync(config.scriptsDir, { recursive: true, force: true });
    fs.rmSync(config.generatedDir, { recursive: true, force: true });
  });
});

describe('Logs API', () => {
  it('GET /api/logs queries with filters', async () => {
    const logs: LogEntry[] = [
      { id: 1, timestamp: Date.now(), level: 'info', entity_id: 'sensor.temp', source_file: 'weather.ts', message: 'Initialized', data: null },
    ];
    const queryLogs = vi.fn(() => logs);
    const config = createTestConfig({ queryLogs });
    const { app } = createServer(config);

    const res = await app.request('/api/logs?level=info&search=Init');
    const data = await res.json() as { logs: LogEntry[]; count: number };

    expect(data.logs).toHaveLength(1);
    expect(data.count).toBe(1);
    expect(queryLogs).toHaveBeenCalledWith(expect.objectContaining({
      level: ['info', 'warn', 'error'],
      search: 'Init',
    }));

    fs.rmSync(config.scriptsDir, { recursive: true, force: true });
    fs.rmSync(config.generatedDir, { recursive: true, force: true });
  });
});

describe('Packages API', () => {
  let config: WebServerConfig;

  beforeEach(() => {
    config = createTestConfig();
  });

  afterEach(() => {
    fs.rmSync(config.scriptsDir, { recursive: true, force: true });
    fs.rmSync(config.generatedDir, { recursive: true, force: true });
  });

  it('GET /api/packages returns dependencies', async () => {
    fs.writeFileSync(
      path.join(config.scriptsDir, 'package.json'),
      JSON.stringify({ dependencies: { axios: '1.0.0' } }),
    );
    const { app } = createServer(config);

    const res = await app.request('/api/packages');
    const data = await res.json() as { dependencies: Record<string, string> };

    expect(data.dependencies.axios).toBe('1.0.0');
  });

  it('POST /api/packages adds dependency', async () => {
    const { app } = createServer(config);

    const res = await app.request('/api/packages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'lodash', version: '^4.0.0' }),
    });
    const data = await res.json() as { success: boolean };

    expect(data.success).toBe(true);

    const pkg = JSON.parse(fs.readFileSync(path.join(config.scriptsDir, 'package.json'), 'utf-8'));
    expect(pkg.dependencies.lodash).toBe('^4.0.0');
  });

  it('DELETE /api/packages/:name removes dependency', async () => {
    fs.writeFileSync(
      path.join(config.scriptsDir, 'package.json'),
      JSON.stringify({ dependencies: { axios: '1.0.0', lodash: '4.0.0' } }),
    );
    const { app } = createServer(config);

    const res = await app.request('/api/packages/axios', { method: 'DELETE' });
    const data = await res.json() as { success: boolean };
    expect(data.success).toBe(true);

    const pkg = JSON.parse(fs.readFileSync(path.join(config.scriptsDir, 'package.json'), 'utf-8'));
    expect(pkg.dependencies.axios).toBeUndefined();
    expect(pkg.dependencies.lodash).toBe('4.0.0');
  });
});

describe('Types API', () => {
  let config: WebServerConfig;

  beforeEach(() => {
    config = createTestConfig();
  });

  afterEach(() => {
    fs.rmSync(config.scriptsDir, { recursive: true, force: true });
    fs.rmSync(config.generatedDir, { recursive: true, force: true });
  });

  it('GET /api/types/status returns not generated', async () => {
    const { app } = createServer(config);
    const res = await app.request('/api/types/status');
    const data = await res.json() as { generated: boolean };
    expect(data.generated).toBe(false);
  });

  it('GET /api/types/status returns generated with meta', async () => {
    fs.writeFileSync(
      path.join(config.generatedDir, 'ha-registry-meta.json'),
      JSON.stringify({ entityCount: 5, haVersion: '2024.3.0' }),
    );
    const { app } = createServer(config);

    const res = await app.request('/api/types/status');
    const data = await res.json() as { generated: boolean; meta: { entityCount: number } };

    expect(data.generated).toBe(true);
    expect(data.meta.entityCount).toBe(5);
  });

  it('POST /api/types/regenerate triggers regeneration', async () => {
    const { app } = createServer(config);
    const res = await app.request('/api/types/regenerate', { method: 'POST' });
    const data = await res.json() as { success: boolean; entityCount: number };

    expect(data.success).toBe(true);
    expect(data.entityCount).toBe(5);
    expect(config.regenerateTypes).toHaveBeenCalled();
  });
});

describe('WSHub', () => {
  it('broadcasts to subscribed clients', () => {
    const hub = new WSHub();
    const sent: string[] = [];
    const client = {
      send: (data: string) => sent.push(data),
      close: vi.fn(),
      readyState: 1,
    };

    hub.subscribe('entities', client);
    hub.broadcast('entities', 'state_changed', { entity_id: 'light.test' });

    expect(sent).toHaveLength(1);
    const msg = JSON.parse(sent[0]);
    expect(msg.channel).toBe('entities');
    expect(msg.event).toBe('state_changed');
    expect(msg.data.entity_id).toBe('light.test');
  });

  it('does not send to unsubscribed clients', () => {
    const hub = new WSHub();
    const sent: string[] = [];
    const client = {
      send: (data: string) => sent.push(data),
      close: vi.fn(),
      readyState: 1,
    };

    const unsub = hub.subscribe('build', client);
    unsub();

    hub.broadcast('build', 'step', {});
    expect(sent).toHaveLength(0);
  });

  it('removes clients with closed connections', () => {
    const hub = new WSHub();
    const client = {
      send: vi.fn(),
      close: vi.fn(),
      readyState: 3, // CLOSED
    };

    hub.subscribe('logs', client);
    hub.broadcast('logs', 'new', {});

    expect(client.send).not.toHaveBeenCalled();
    expect(hub.getClientCount('logs')).toBe(0);
  });

  it('reports client count per channel', () => {
    const hub = new WSHub();
    const mkClient = () => ({ send: vi.fn(), close: vi.fn(), readyState: 1 });

    hub.subscribe('build', mkClient());
    hub.subscribe('build', mkClient());
    hub.subscribe('entities', mkClient());

    expect(hub.getClientCount('build')).toBe(2);
    expect(hub.getClientCount('entities')).toBe(1);
    expect(hub.getClientCount('logs')).toBe(0);
  });

  it('closeAll disconnects all clients', () => {
    const hub = new WSHub();
    const client1 = { send: vi.fn(), close: vi.fn(), readyState: 1 };
    const client2 = { send: vi.fn(), close: vi.fn(), readyState: 1 };

    hub.subscribe('build', client1);
    hub.subscribe('entities', client2);
    hub.closeAll();

    expect(client1.close).toHaveBeenCalled();
    expect(client2.close).toHaveBeenCalled();
    expect(hub.getClientCount('build')).toBe(0);
    expect(hub.getClientCount('entities')).toBe(0);
  });
});

describe('generateUIHtml', () => {
  it('generates valid HTML with ingress path', () => {
    const html = generateUIHtml('/api/hassio_ingress/test123');
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('TS Entities');
    expect(html).toContain('monaco-editor');
    expect(html).toContain('/api/hassio_ingress/test123');
  });

  it('generates HTML with empty ingress path', () => {
    const html = generateUIHtml('');
    expect(html).toContain('window.__INGRESS_PATH__');
  });
});

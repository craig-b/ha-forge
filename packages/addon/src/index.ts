import type { MqttCredentials } from '@ha-ts-entities/runtime';

export interface AddonOptions {
  log_level: 'debug' | 'info' | 'warn' | 'error';
  log_retention_days: number;
  validation_schedule_minutes: number;
  auto_build_on_save: boolean;
  auto_rebuild_on_registry_change: boolean;
}

const DEFAULT_OPTIONS: AddonOptions = {
  log_level: 'info',
  log_retention_days: 7,
  validation_schedule_minutes: 60,
  auto_build_on_save: false,
  auto_rebuild_on_registry_change: false,
};

export async function fetchMqttCredentials(): Promise<MqttCredentials> {
  const token = process.env.SUPERVISOR_TOKEN;
  if (!token) {
    throw new Error('SUPERVISOR_TOKEN not set — not running as HA add-on?');
  }

  const response = await fetch('http://supervisor/services/mqtt', {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    throw new Error(`Failed to get MQTT credentials: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as { data: MqttCredentials };
  return data.data;
}

export async function readOptions(): Promise<AddonOptions> {
  try {
    const { readFile } = await import('node:fs/promises');
    const raw = await readFile('/data/options.json', 'utf-8');
    return { ...DEFAULT_OPTIONS, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_OPTIONS;
  }
}

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] [ts-entities] ${msg}`);
}

async function main(): Promise<void> {
  const options = await readOptions();
  log(`Starting with log_level=${options.log_level}`);
  log(`Node ${process.version}`);
  // Debug: log relevant env vars
  const envKeys = Object.keys(process.env).filter(k =>
    k.includes('SUPERVISOR') || k.includes('HASSIO') || k.includes('TOKEN') || k.includes('MQTT')
  );
  log(`Env vars: ${envKeys.map(k => `${k}=${process.env[k]?.slice(0, 8)}...`).join(', ') || 'none matching'}`);

  // Step 1: SQLite Logger
  log('Initializing SQLite logger...');
  const { SQLiteLogger } = await import('@ha-ts-entities/runtime');
  let logger: InstanceType<typeof SQLiteLogger>;
  try {
    logger = new SQLiteLogger({
      dbPath: '/data/logs.db',
      minLevel: options.log_level,
      retentionDays: options.log_retention_days,
    });
    const cleaned = logger.cleanup();
    if (cleaned.deleted > 0) log(`Cleaned ${cleaned.deleted} old log entries`);
  } catch (err) {
    log(`SQLite /data/logs.db failed, using in-memory: ${err instanceof Error ? err.message : String(err)}`);
    logger = new SQLiteLogger({ dbPath: ':memory:', minLevel: options.log_level, retentionDays: 0 });
  }
  log('SQLite logger ready');

  // Step 2: MQTT
  let mqttTransport: import('@ha-ts-entities/runtime').MqttTransport | null = null;
  try {
    log('Connecting MQTT...');
    const credentials = await fetchMqttCredentials();
    const { MqttTransport } = await import('@ha-ts-entities/runtime');
    mqttTransport = new MqttTransport({
      credentials,
      onConnect: () => logger.info('MQTT connected'),
      onDisconnect: () => logger.warn('MQTT disconnected'),
      onReconnect: () => logger.info('MQTT reconnecting'),
      onError: (err) => logger.error('MQTT error', { error: err.message }),
    });
    await mqttTransport.connect();
    log(`MQTT connected to ${credentials.host}:${credentials.port}`);
  } catch (err) {
    log(`MQTT failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Step 3: HA WebSocket
  let wsClient: import('@ha-ts-entities/runtime').HAWebSocketClient | null = null;
  try {
    log('Connecting HA WebSocket...');
    const { HAWebSocketClient } = await import('@ha-ts-entities/runtime');
    wsClient = new HAWebSocketClient({
      url: 'ws://supervisor/core/websocket',
      token: process.env.SUPERVISOR_TOKEN!,
    });
    await wsClient.connect();
    log(`WebSocket connected (HA ${wsClient.getHAVersion()})`);
  } catch (err) {
    log(`WebSocket failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Step 4: Web server
  try {
    log('Starting web server...');
    const { createServer } = await import('@ha-ts-entities/web');
    const { BuildManager, HealthEntities, HAApiImpl } = await import('@ha-ts-entities/runtime');
    const { runBuild } = await import('@ha-ts-entities/build');

    let haApi: import('@ha-ts-entities/runtime').HAApiImpl | null = null;
    if (wsClient) {
      haApi = new HAApiImpl(wsClient);
      await haApi.init();
    }

    let healthEntities: InstanceType<typeof HealthEntities> | null = null;
    if (mqttTransport) {
      healthEntities = new HealthEntities(mqttTransport);
      await healthEntities.register();
    }

    const buildManager = mqttTransport
      ? new BuildManager({ bundleDir: '/data/last-build', transport: mqttTransport, logger, haClient: haApi })
      : null;

    let building = false;
    let lastBuildResult: {
      success: boolean; timestamp: string; totalDuration: number;
      steps: Array<{ step: string; success: boolean; duration: number; error?: string }>;
      typeErrors: number; bundleErrors: number; entityCount: number;
    } | null = null;

    const { app } = createServer({
      scriptsDir: '/config',
      generatedDir: '/config/.generated',
      triggerBuild: async () => {
        if (building) return { building: true, lastBuild: lastBuildResult };
        building = true;
        try {
          const result = await runBuild({
            scriptsDir: '/config', generatedDir: '/config/.generated',
            outputDir: '/data/last-build', wsClient: wsClient ?? undefined,
          });
          if (healthEntities && result.tscCheck) {
            await healthEntities.update({ diagnostics: result.tscCheck.diagnostics, trigger: 'build' });
          }
          let entityCount = 0;
          if (result.bundle?.success && buildManager) {
            entityCount = (await buildManager.deploy()).entityCount;
          }
          lastBuildResult = {
            success: result.success, timestamp: result.timestamp, totalDuration: result.totalDuration,
            steps: result.steps,
            typeErrors: result.tscCheck?.diagnostics.filter((d) => d.severity === 'error').length ?? 0,
            bundleErrors: result.bundle?.errors.length ?? 0, entityCount,
          };
          logger.info('Build complete', { success: result.success, entityCount, duration: result.totalDuration });
        } catch (err) {
          logger.error('Build failed', { error: err instanceof Error ? err.message : String(err) });
        } finally { building = false; }
        return { building: false, lastBuild: lastBuildResult };
      },
      getBuildStatus: () => ({ building, lastBuild: lastBuildResult }),
      getEntities: () => {
        if (!buildManager) return [];
        return buildManager.getEntityIds().map((id) => ({
          id, name: id, type: 'unknown', state: buildManager.getEntityState(id), sourceFile: '', status: 'healthy' as const,
        }));
      },
      queryLogs: (opts) => logger.query(opts),
      regenerateTypes: async () => {
        if (!wsClient) return { success: false, entityCount: 0, serviceCount: 0, errors: ['No WebSocket connection'] };
        const { generateTypes, fetchRegistryData } = await import('@ha-ts-entities/build');
        const data = await fetchRegistryData(wsClient);
        return generateTypes(data, '/config/.generated');
      },
    });

    const { serve } = await import('@hono/node-server');
    serve({ fetch: app.fetch, port: 8099 });
    log('Web server listening on port 8099');
  } catch (err) {
    log(`Web server failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    // Fallback: keep process alive with basic HTTP
    const http = await import('node:http');
    http.createServer((_req, res) => {
      res.writeHead(500, { 'Content-Type': 'text/html' });
      res.end(`<h1>TS Entities</h1><p>Startup error: ${err instanceof Error ? err.message : String(err)}</p>`);
    }).listen(8099);
    log('Fallback web server on port 8099');
  }

  // Step 5: Load cached build
  const fs = await import('node:fs');
  if (fs.existsSync('/data/last-build') && mqttTransport) {
    try {
      const { BuildManager } = await import('@ha-ts-entities/runtime');
      const cached = new BuildManager({ bundleDir: '/data/last-build', transport: mqttTransport, logger });
      const result = await cached.deploy();
      log(`Cached build loaded: ${result.entityCount} entities`);
    } catch (err) {
      log(`Cached build failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Step 6: Scheduled validation
  if (options.validation_schedule_minutes > 0 && wsClient) {
    const { runValidation } = await import('@ha-ts-entities/build');
    const intervalMs = options.validation_schedule_minutes * 60 * 1000;
    setInterval(async () => {
      try {
        const result = await runValidation({ scriptsDir: '/config', generatedDir: '/config/.generated', wsClient: wsClient! });
        logger.info('Validation complete', { success: result.success, diagnostics: result.diagnostics.length });
      } catch (err) {
        logger.error('Validation failed', { error: err instanceof Error ? err.message : String(err) });
      }
    }, intervalMs);
    log(`Scheduled validation every ${options.validation_schedule_minutes}m`);
  }

  // Log cleanup every 6 hours
  setInterval(() => {
    const result = logger.cleanup();
    if (result.deleted > 0) logger.info(`Log cleanup: removed ${result.deleted} entries`);
  }, 6 * 60 * 60 * 1000);

  log('Add-on started successfully');

  // Graceful shutdown
  const shutdown = async () => {
    log('Shutting down...');
    logger.flush();
    if (wsClient) try { wsClient.disconnect(); } catch { /* */ }
    if (mqttTransport) try { await mqttTransport.disconnect(); } catch { /* */ }
    logger.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

// Only run main if this is the entry point
const isMain = process.argv[1]?.endsWith('addon/dist/index.js') ||
               process.argv[1]?.endsWith('addon/src/index.ts');
if (isMain) {
  process.on('uncaughtException', (err) => {
    console.error('[ts-entities] Uncaught exception:', err);
  });
  process.on('unhandledRejection', (err) => {
    console.error('[ts-entities] Unhandled rejection:', err);
  });
  main().catch((err) => {
    console.error('[ts-entities] Fatal error:', err);
    process.exit(1);
  });
}

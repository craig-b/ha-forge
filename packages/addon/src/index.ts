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

async function main(): Promise<void> {
  const options = await readOptions();
  console.log(`[ts-entities] Starting with log_level=${options.log_level}`);

  // Startup sequence (from infrastructure.md):
  // 1. Read add-on options ✓ (above)
  // 2. Initialize SQLite logger
  // 3. Connect to MQTT broker
  // 4. Configure LWT, publish online
  // 5. Connect to HA WebSocket API
  // 6. Start web server on ingress port (8099)
  // 7. Load cached build from /data/last-build/ if exists
  // 8. Start scheduled validation timer
  // 9. Subscribe to homeassistant/status for HA restart re-discovery

  // Step 2: SQLite Logger
  const { SQLiteLogger } = await import('@ha-ts-entities/runtime');
  const logger = new SQLiteLogger({
    dbPath: '/data/logs.db',
    minLevel: options.log_level,
    retentionDays: options.log_retention_days,
  });

  // Run retention cleanup on startup
  const cleaned = logger.cleanup();
  if (cleaned.deleted > 0) {
    logger.info(`Cleaned ${cleaned.deleted} old log entries`);
  }

  logger.info('Add-on starting', { log_level: options.log_level });

  // Step 3-4: MQTT
  let mqttTransport: import('@ha-ts-entities/runtime').MqttTransport | null = null;
  try {
    const credentials = await fetchMqttCredentials();
    const { MqttTransport } = await import('@ha-ts-entities/runtime');
    mqttTransport = new MqttTransport({
      credentials,
      onConnect: () => logger.info('MQTT connected'),
      onDisconnect: () => logger.warn('MQTT disconnected'),
      onReconnect: () => logger.info('MQTT reconnecting — will re-publish discovery'),
      onError: (err) => logger.error('MQTT error', { error: err.message }),
    });
    await mqttTransport.connect();
    logger.info('MQTT connected', { host: credentials.host, port: credentials.port });
  } catch (err) {
    logger.error('Failed to connect MQTT', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Step 5: HA WebSocket API
  let wsClient: import('@ha-ts-entities/runtime').HAWebSocketClient | null = null;
  try {
    const { HAWebSocketClient } = await import('@ha-ts-entities/runtime');
    wsClient = new HAWebSocketClient({
      url: 'ws://supervisor/core/websocket',
      token: process.env.SUPERVISOR_TOKEN!,
    });
    await wsClient.connect();
    logger.info('WebSocket connected to HA', { version: wsClient.getHAVersion() });
  } catch (err) {
    logger.error('Failed to connect WebSocket', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Step 6: Web server
  try {
    const { createServer } = await import('@ha-ts-entities/web');
    const { BuildManager, HealthEntities, HAApiImpl } = await import('@ha-ts-entities/runtime');
    const { runBuild } = await import('@ha-ts-entities/build');

    // Initialize HA API if WS available
    let haApi: import('@ha-ts-entities/runtime').HAApiImpl | null = null;
    if (wsClient) {
      haApi = new HAApiImpl(wsClient);
      await haApi.init();
    }

    // Initialize health entities
    let healthEntities: InstanceType<typeof HealthEntities> | null = null;
    if (mqttTransport) {
      healthEntities = new HealthEntities(mqttTransport);
      await healthEntities.register();
    }

    // Initialize build manager
    const buildManager = mqttTransport
      ? new BuildManager({
          bundleDir: '/data/last-build',
          transport: mqttTransport,
          logger,
          haClient: haApi,
        })
      : null;

    // Build state tracking
    let building = false;
    let lastBuildResult: {
      success: boolean;
      timestamp: string;
      totalDuration: number;
      steps: Array<{ step: string; success: boolean; duration: number; error?: string }>;
      typeErrors: number;
      bundleErrors: number;
      entityCount: number;
    } | null = null;

    const { app } = createServer({
      scriptsDir: '/config',
      generatedDir: '/config/.generated',
      triggerBuild: async () => {
        if (building) return { building: true, lastBuild: lastBuildResult };
        building = true;
        try {
          const result = await runBuild({
            scriptsDir: '/config',
            generatedDir: '/config/.generated',
            outputDir: '/data/last-build',
            wsClient: wsClient ?? undefined,
          });

          // Update health entities
          if (healthEntities && result.tscCheck) {
            await healthEntities.update({
              diagnostics: result.tscCheck.diagnostics,
              trigger: 'build',
            });
          }

          // Deploy entities
          let entityCount = 0;
          if (result.bundle?.success && buildManager) {
            const deployResult = await buildManager.deploy();
            entityCount = deployResult.entityCount;
          }

          lastBuildResult = {
            success: result.success,
            timestamp: result.timestamp,
            totalDuration: result.totalDuration,
            steps: result.steps,
            typeErrors: result.tscCheck?.diagnostics.filter((d) => d.severity === 'error').length ?? 0,
            bundleErrors: result.bundle?.errors.length ?? 0,
            entityCount,
          };

          logger.info('Build complete', {
            success: result.success,
            entityCount,
            duration: result.totalDuration,
          });
        } catch (err) {
          logger.error('Build failed', { error: err instanceof Error ? err.message : String(err) });
        } finally {
          building = false;
        }
        return { building: false, lastBuild: lastBuildResult };
      },
      getBuildStatus: () => ({ building, lastBuild: lastBuildResult }),
      getEntities: () => {
        if (!buildManager) return [];
        return buildManager.getEntityIds().map((id) => ({
          id,
          name: id,
          type: 'unknown',
          state: buildManager.getEntityState(id),
          sourceFile: '',
          status: 'healthy' as const,
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

    // Start the server using Node's built-in http
    const { serve } = await import('@hono/node-server');
    const port = 8099;
    serve({ fetch: app.fetch, port });
    logger.info(`Web server started on port ${port}`);
  } catch (err) {
    logger.error('Failed to start web server', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Step 7: Load cached build
  const fs = await import('node:fs');
  if (fs.existsSync('/data/last-build') && mqttTransport) {
    logger.info('Loading cached build from /data/last-build');
    try {
      const { BuildManager } = await import('@ha-ts-entities/runtime');
      const cachedManager = new BuildManager({
        bundleDir: '/data/last-build',
        transport: mqttTransport,
        logger,
      });
      const result = await cachedManager.deploy();
      logger.info(`Cached build loaded: ${result.entityCount} entities`);
    } catch (err) {
      logger.error('Failed to load cached build', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Step 8: Scheduled validation
  const validationIntervalMs = options.validation_schedule_minutes * 60 * 1000;
  if (validationIntervalMs > 0 && wsClient) {
    const { runValidation } = await import('@ha-ts-entities/build');
    const runScheduledValidation = async () => {
      try {
        const result = await runValidation({
          scriptsDir: '/config',
          generatedDir: '/config/.generated',
          wsClient: wsClient!,
        });
        logger.info('Scheduled validation complete', {
          success: result.success,
          diagnostics: result.diagnostics.length,
        });
      } catch (err) {
        logger.error('Scheduled validation failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };

    setInterval(runScheduledValidation, validationIntervalMs);
    logger.info(`Scheduled validation every ${options.validation_schedule_minutes} minutes`);
  }

  // Step 9: Cleanup timer (every 6 hours)
  setInterval(() => {
    const result = logger.cleanup();
    if (result.deleted > 0) {
      logger.info(`Log cleanup: removed ${result.deleted} entries`);
    }
  }, 6 * 60 * 60 * 1000);

  logger.info('Add-on started successfully');

  // Keep process alive
  const shutdown = async () => {
    logger.info('Shutting down...');
    logger.flush();
    if (wsClient) {
      try { wsClient.disconnect(); } catch { /* ignore */ }
    }
    if (mqttTransport) {
      try { await mqttTransport.disconnect(); } catch { /* ignore */ }
    }
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
  main().catch((err) => {
    console.error('[ts-entities] Fatal error:', err);
    process.exit(1);
  });
}

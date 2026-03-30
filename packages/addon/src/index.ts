import type { MqttCredentials } from '@ha-forge/runtime';
import { GitService } from '@ha-forge/runtime';

export interface AddonOptions {
  log_level: 'debug' | 'info' | 'warn' | 'error';
  log_retention_days: number;
  validation_schedule_minutes: number;
  auto_build_on_save: boolean;
  auto_rebuild_on_registry_change: boolean;
  mqtt_host: string;
  mqtt_port: number;
  mqtt_username: string;
  mqtt_password: string;
  secrets: Array<{ name: string; value: string }>;
}

const DEFAULT_OPTIONS: AddonOptions = {
  log_level: 'info',
  log_retention_days: 7,
  validation_schedule_minutes: 60,
  auto_build_on_save: false,
  auto_rebuild_on_registry_change: false,
  mqtt_host: '',
  mqtt_port: 1883,
  mqtt_username: '',
  mqtt_password: '',
  secrets: [],
};

export async function fetchMqttCredentials(options: AddonOptions): Promise<MqttCredentials> {
  // Try Supervisor service API first (works with Mosquitto add-on)
  const token = process.env.SUPERVISOR_TOKEN;
  if (token) {
    try {
      const response = await fetch('http://supervisor/services/mqtt', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.ok) {
        const data = (await response.json()) as { data: MqttCredentials };
        return data.data;
      }
    } catch { /* fall through to options */ }
  }

  // Fall back to add-on options
  if (options.mqtt_host) {
    return {
      host: options.mqtt_host,
      port: options.mqtt_port,
      username: options.mqtt_username || undefined,
      password: options.mqtt_password || undefined,
    } as MqttCredentials;
  }

  throw new Error('No MQTT credentials: Supervisor MQTT service not available and mqtt_host not configured');
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
  console.log(`[${new Date().toISOString()}] [ha-forge] ${msg}`);
}

async function main(): Promise<void> {
  const options = await readOptions();
  log(`Starting with log_level=${options.log_level}`);

  // Populate secrets store so ha.secret() works in user scripts
  if (options.secrets.length > 0) {
    const { setSecrets } = await import('@ha-forge/runtime');
    const secretsMap: Record<string, string> = {};
    for (const { name, value } of options.secrets) {
      if (name) secretsMap[name] = value;
    }
    setSecrets(secretsMap);
    log(`Loaded ${Object.keys(secretsMap).length} secret(s)`);
  }
  log(`Node ${process.version}`);

  // Hoisted so scheduled validation can update health entities
  let healthEntities: { update(opts: { diagnostics: Array<{ severity: string }>; trigger: string }): Promise<void> } | null = null;

  // Step 1: SQLite Logger
  log('Initializing SQLite logger...');
  const { SQLiteLogger } = await import('@ha-forge/runtime');
  // Late-bound broadcast function — set after wsHub is created
  let broadcastLog: ((entry: import('@ha-forge/runtime').LogEntry) => void) | null = null;
  let logger: InstanceType<typeof SQLiteLogger>;
  try {
    logger = new SQLiteLogger({
      dbPath: '/data/logs.db',
      minLevel: options.log_level,
      retentionDays: options.log_retention_days,
      onNewEntry: (entry) => broadcastLog?.(entry),
    });
    const cleaned = logger.cleanup();
    if (cleaned.deleted > 0) log(`Cleaned ${cleaned.deleted} old log entries`);
  } catch (err) {
    log(`SQLite /data/logs.db failed, using in-memory: ${err instanceof Error ? err.message : String(err)}`);
    logger = new SQLiteLogger({ dbPath: ':memory:', minLevel: options.log_level, retentionDays: 0, onNewEntry: (entry) => broadcastLog?.(entry) });
  }
  log('SQLite logger ready');

  // Step 2: MQTT
  let mqttTransport: import('@ha-forge/runtime').MqttTransport | null = null;
  try {
    log('Connecting MQTT...');
    const credentials = await fetchMqttCredentials(options);
    const { MqttTransport } = await import('@ha-forge/runtime');
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
  // Late-bound event handler — set after HAApiImpl is created
  let handleHAEvent: ((subId: number, event: import('@ha-forge/runtime').HAEvent) => void) | null = null;
  let wsClient: import('@ha-forge/runtime').HAWebSocketClient | null = null;
  try {
    log('Connecting HA WebSocket...');
    const { HAWebSocketClient } = await import('@ha-forge/runtime');
    const supervisorToken = process.env.SUPERVISOR_TOKEN;
    if (!supervisorToken) {
      throw new Error('SUPERVISOR_TOKEN environment variable is not set — cannot connect to HA WebSocket');
    }
    wsClient = new HAWebSocketClient({
      url: 'ws://supervisor/core/websocket',
      token: supervisorToken,
      onEvent: (subId, event) => handleHAEvent?.(subId, event),
    });
    await wsClient.connect();
    log(`WebSocket connected (HA ${wsClient.getHAVersion()})`);
  } catch (err) {
    log(`WebSocket failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Step 4: Web server
  try {
    log('Starting web server...');
    const { createServer } = await import('@ha-forge/web');
    const { BuildManager, HealthEntities, HAApiImpl, installGlobals } = await import('@ha-forge/runtime');
    const { runBuild } = await import('@ha-forge/build');

    const haLogger = logger.forEntity ? logger.forEntity('_ha', '_global') as typeof logger : logger;
    let haApi: import('@ha-forge/runtime').HAApiImpl | null = null;
    if (wsClient) {
      haApi = new HAApiImpl(wsClient, haLogger, undefined, async (path) => {
        const token = process.env.SUPERVISOR_TOKEN;
        if (!token) throw new Error('SUPERVISOR_TOKEN not available');
        return fetch(`http://supervisor/core/api${path}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
      });
      // Wire up WebSocket events → HAApiImpl for ha.on()/reactions()
      handleHAEvent = (subId, event) => haApi!.handleEvent(subId, event);
      await haApi.init();
    }

    // Install SDK globals (sensor, light, ha, etc.) before any user scripts run
    await installGlobals(haApi ?? undefined, haLogger);

    // Run npm install on startup so user deps survive restarts
    try {
      const { npmInstall } = await import('@ha-forge/build');
      const npmResult = await npmInstall('/config', '/data/node_modules', '/data/pnpm-store');
      if (npmResult.skipped) {
        log('npm install skipped (no changes)');
      } else {
        log(`npm install complete (${npmResult.duration}ms)`);
      }
    } catch (err) {
      log(`npm install failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Initialize git repo for file versioning
    const gitService = new GitService('/config');
    try {
      await gitService.ensureRepo();
      log('Git repo initialized for /config');
    } catch (err) {
      log(`Git init failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Load responding services from meta JSON into HAApiImpl
    const fsCheck = await import('node:fs');
    const loadServiceMeta = () => {
      if (!haApi) return;
      try {
        const metaPath = '/config/.generated/ha-registry-meta.json';
        if (fsCheck.existsSync(metaPath)) {
          const meta = JSON.parse(fsCheck.readFileSync(metaPath, 'utf-8'));
          if (Array.isArray(meta.respondingServices)) {
            haApi.setRespondingServices(meta.respondingServices);
          }
        }
      } catch { /* non-fatal */ }
    };

    // Generate types on first boot if .generated doesn't exist
    if (!fsCheck.existsSync('/config/.generated/ha-registry.d.ts') && wsClient) {
      try {
        log('First boot: generating types...');
        const { generateTypes, fetchRegistryData } = await import('@ha-forge/build');
        const data = await fetchRegistryData(wsClient);
        const result = generateTypes(data, '/config/.generated', '/config/captures');
        log(`Types generated: ${result.entityCount} entities, ${result.serviceCount} services`);
      } catch (err) {
        log(`Type generation failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    loadServiceMeta();

    if (mqttTransport) {
      healthEntities = new HealthEntities(mqttTransport);
      await (healthEntities as InstanceType<typeof HealthEntities>).register();
    }

    // Late-bound entity state broadcast — set after wsHub is created
    let broadcastEntityState: ((entityId: string, state: unknown) => void) | null = null;
    const buildManager = mqttTransport
      ? new BuildManager({
          bundleDir: '/data/last-build', transport: mqttTransport, logger, rawMqtt: mqttTransport,
          onEntityStateChange: (entityId, state) => broadcastEntityState?.(entityId, state),
          haApi,
        })
      : null;

    let building = false;
    let lastBuildResult: {
      success: boolean; timestamp: string; totalDuration: number;
      steps: Array<{ step: string; success: boolean; duration: number; error?: string; diagnostics?: Array<{ file: string; line: number; column: number; code: number; message: string; severity: 'error' | 'warning' }> }>;
      typeErrors: number; bundleErrors: number;
    } | null = null;

    const { app, wsHub } = createServer({
      scriptsDir: '/config',
      generatedDir: '/config/.generated',
      capturesDir: '/config/captures',
      gitService,
      fetchFromHA: async (path) => {
        const token = process.env.SUPERVISOR_TOKEN;
        if (!token) throw new Error('SUPERVISOR_TOKEN not available');
        return fetch(`http://supervisor/core/api${path}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
      },
      triggerBuild: async () => {
        if (building) return { building: true, lastBuild: lastBuildResult };
        building = true;
        try {
          const result = await runBuild({
            scriptsDir: '/config', generatedDir: '/config/.generated',
            outputDir: '/data/last-build', wsClient: wsClient ?? undefined,
            nodeModulesDir: '/data/node_modules', storeDir: '/data/pnpm-store',
            onStep: (step) => wsHub.broadcast('build', 'step_complete', step),
          });
          if (healthEntities && result.tscCheck) {
            await healthEntities.update({ diagnostics: result.tscCheck.diagnostics, trigger: 'build' });
          }
          const stepsWithDiagnostics = result.steps.map((step) => {
            if (step.step === 'tsc-check' && result.tscCheck?.diagnostics.length) {
              return { ...step, diagnostics: result.tscCheck.diagnostics };
            }
            if (step.step === 'bundle' && result.bundle) {
              const bundleDiags = result.bundle.files
                .filter((f) => !f.success)
                .map((f) => ({
                  file: f.inputFile.replace(/^\/config\//, ''),
                  line: 1,
                  column: 1,
                  code: 0,
                  message: f.errors.join('; '),
                  severity: 'error' as const,
                }));
              if (bundleDiags.length) return { ...step, diagnostics: bundleDiags };
            }
            return step;
          });
          lastBuildResult = {
            success: result.success, timestamp: result.timestamp, totalDuration: result.totalDuration,
            steps: stepsWithDiagnostics,
            typeErrors: result.tscCheck?.diagnostics.filter((d) => d.severity === 'error').length ?? 0,
            bundleErrors: (result.bundle ? result.bundle.errors.length + result.bundle.files.filter((f) => !f.success).length : 0),
          };
          logger.info('Build complete', { success: result.success, duration: result.totalDuration });
        } catch (err) {
          logger.error('Build failed', { error: err instanceof Error ? err.message : String(err) });
        } finally { building = false; }
        return { building: false, lastBuild: lastBuildResult };
      },
      triggerDeploy: async () => {
        if (!buildManager) return { success: false, entityCount: 0, errors: [{ file: '', error: 'No MQTT connection' }], duration: 0 };
        try {
          const result = await buildManager.smartDeploy();
          wsHub.broadcast('entities', 'deployed', { entityCount: result.entityCount });
          logger.info('Deploy complete', { entityCount: result.entityCount, duration: result.duration });
          return result;
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          logger.error('Deploy failed', { error: errorMsg });
          return { success: false, entityCount: 0, errors: [{ file: '', error: errorMsg }], duration: 0 };
        }
      },
      getBuildStatus: () => ({ building, lastBuild: lastBuildResult }),
      getEntities: () => {
        if (!buildManager) return [];
        return buildManager.getEntityIds().map((id) => {
          const info = buildManager.getEntityInfo(id);
          return {
            id,
            name: info?.name ?? id,
            type: info?.type ?? 'unknown',
            state: buildManager.getEntityState(id),
            sourceFile: info?.sourceFile ?? '',
            status: 'healthy' as const,
            unit_of_measurement: info?.unit_of_measurement,
            next_fire: info?.next_fire,
            cron_description: info?.cron_description,
          };
        });
      },
      queryLogs: (opts) => logger.query(opts),
      getLogEntityIds: () => logger.getEntityIds(),
      regenerateTypes: async () => {
        if (!wsClient) return { success: false, entityCount: 0, serviceCount: 0, errors: ['No WebSocket connection'] };
        const { generateTypes, fetchRegistryData } = await import('@ha-forge/build');
        const data = await fetchRegistryData(wsClient);
        const result = generateTypes(data, '/config/.generated', '/config/captures');
        loadServiceMeta();
        return result;
      },
    });

    // Wire up real-time broadcasting via WebSocket
    broadcastLog = (entry) => wsHub.broadcast('logs', 'new', entry);
    broadcastEntityState = (entityId, state) => wsHub.broadcast('entities', 'state_changed', { entityId, state });

    // Start HTTP server with WebSocket upgrade support
    const { createAdaptorServer } = await import('@hono/node-server');
    const { WebSocketServer } = await import('ws');
    const server = createAdaptorServer({ fetch: app.fetch });
    const wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (req, socket, head) => {
      // Accept upgrade on /ws (with or without ingress prefix)
      const url = req.url ?? '';
      if (url === '/ws' || url === '//ws' || url.endsWith('/ws')) {
        wss.handleUpgrade(req, socket, head, (ws) => {
          // Subscribe to all channels
          const unsubs = [
            wsHub.subscribe('build', ws),
            wsHub.subscribe('entities', ws),
            wsHub.subscribe('logs', ws),
          ];
          ws.on('close', () => unsubs.forEach((fn) => fn()));
        });
      } else {
        socket.destroy();
      }
    });

    server.listen(8099);
    log('Web server listening on port 8099');

    // Step 5: Load cached build (reuses buildManager from step 4)
    const fs = await import('node:fs');
    if (fs.existsSync('/data/last-build') && buildManager) {
      try {
        const result = await buildManager.deploy();
        log(`Cached build loaded: ${result.entityCount} entities`);
      } catch (err) {
        log(`Cached build failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Step 6: File watcher for auto-build on save
    if (options.auto_build_on_save) {
      const DEBOUNCE_MS = 500;
      let debounceTimer: ReturnType<typeof globalThis.setTimeout> | null = null;

      const triggerAutoBuild = async () => {
        if (building) return;
        building = true;
        try {
          const result = await runBuild({
            scriptsDir: '/config', generatedDir: '/config/.generated',
            outputDir: '/data/last-build', wsClient: wsClient ?? undefined,
            nodeModulesDir: '/data/node_modules', storeDir: '/data/pnpm-store',
            onStep: (step) => wsHub.broadcast('build', 'step_complete', step),
          });
          if (healthEntities && result.tscCheck) {
            await healthEntities.update({ diagnostics: result.tscCheck.diagnostics, trigger: 'build' });
          }
          logger.info('Auto-build complete', { success: result.success, duration: result.totalDuration });
        } catch (err) {
          logger.error('Auto-build failed', { error: err instanceof Error ? err.message : String(err) });
        } finally { building = false; }
      };

      try {
        fs.watch('/config', { recursive: true }, (_event, filename) => {
          if (!filename) return;
          const name = String(filename);
          if (!name.endsWith('.ts')) return;
          if (name.startsWith('.') || name.includes('node_modules') || name.includes('.generated') || name.includes('.git')) return;
          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = globalThis.setTimeout(triggerAutoBuild, DEBOUNCE_MS);
        });
        log('File watcher active on /config (auto-build on save)');
      } catch (err) {
        log(`File watcher failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Step 6b: Auto-rebuild on registry change (validation only — no entity redeploy)
    if (options.auto_rebuild_on_registry_change && wsClient && haApi) {
      const REGISTRY_CHECK_INTERVAL = 60_000; // Check every 60s
      let knownEntityIds: Set<string> | null = null;

      const checkRegistryChange = async () => {
        try {
          const currentEntities = await haApi!.getEntities();
          const currentSet = new Set(currentEntities);

          if (knownEntityIds === null) {
            // First run — just store the baseline
            knownEntityIds = currentSet;
            return;
          }

          // Detect additions or removals
          const added = currentEntities.filter((id) => !knownEntityIds!.has(id));
          const removed = [...knownEntityIds].filter((id) => !currentSet.has(id));

          if (added.length === 0 && removed.length === 0) return;

          logger.info('HA entity registry changed', { added: added.length, removed: removed.length });
          knownEntityIds = currentSet;

          // Regenerate types and run validation
          const { generateTypes, fetchRegistryData, runValidation } = await import('@ha-forge/build');
          const data = await fetchRegistryData(wsClient!);
          const typeResult = generateTypes(data, '/config/.generated', '/config/captures');
          loadServiceMeta();
          logger.info('Types regenerated', { entityCount: typeResult.entityCount, serviceCount: typeResult.serviceCount });

          const valResult = await runValidation({ scriptsDir: '/config', generatedDir: '/config/.generated', wsClient: wsClient! });
          if (healthEntities && valResult.diagnostics) {
            await healthEntities.update({ diagnostics: valResult.diagnostics, trigger: 'registry_change' });
          }
          logger.info('Validation after registry change', { success: valResult.success, diagnostics: valResult.diagnostics.length });
        } catch (err) {
          logger.error('Registry change check failed', { error: err instanceof Error ? err.message : String(err) });
        }
      };

      setInterval(checkRegistryChange, REGISTRY_CHECK_INTERVAL);
      // Run initial baseline after a short delay (let HA settle)
      globalThis.setTimeout(checkRegistryChange, 5000);
      log('Registry change watcher active (validation only, 60s interval)');
    }
  } catch (err) {
    log(`Web server failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    // Fallback: keep process alive with basic HTTP
    const http = await import('node:http');
    http.createServer((_req, res) => {
      res.writeHead(500, { 'Content-Type': 'text/html' });
      res.end(`<h1>HA Forge</h1><p>Startup error: ${err instanceof Error ? err.message : String(err)}</p>`);
    }).listen(8099);
    log('Fallback web server on port 8099');
  }

  // Step 7: Scheduled validation
  if (options.validation_schedule_minutes > 0 && wsClient) {
    const { runValidation } = await import('@ha-forge/build');
    const intervalMs = options.validation_schedule_minutes * 60 * 1000;
    setInterval(async () => {
      try {
        const result = await runValidation({ scriptsDir: '/config', generatedDir: '/config/.generated', wsClient: wsClient! });
        if (healthEntities) {
          await healthEntities.update({ diagnostics: result.diagnostics, trigger: 'scheduled' });
        }
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
    console.error('[ha-forge] Uncaught exception:', err);
  });
  process.on('unhandledRejection', (err) => {
    console.error('[ha-forge] Unhandled rejection:', err);
  });
  main().catch((err) => {
    console.error('[ha-forge] Fatal error:', err);
    process.exit(1);
  });
}

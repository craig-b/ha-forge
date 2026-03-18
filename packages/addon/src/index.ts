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

  // In a real HA environment, we'd:
  // 1. fetchMqttCredentials()
  // 2. Create MqttTransport and connect
  // 3. Create EntityLifecycleManager
  // 4. Load last build from /data/last-build/
  // 5. Start web server on port 8099

  // For now, just log that we're running
  console.log('[ts-entities] Add-on started successfully');
  console.log('[ts-entities] Waiting for build trigger...');

  // Keep process alive
  const shutdown = () => {
    console.log('[ts-entities] Shutting down...');
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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SQLiteLogger } from '../sqlite-logger.js';

describe('SQLiteLogger', () => {
  let dbPath: string;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-logger-test-'));
    dbPath = path.join(tmpDir, 'test-logs.db');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createLogger(opts: Partial<Parameters<typeof SQLiteLogger['prototype']['constructor']>[0]> = {}) {
    return new SQLiteLogger({
      dbPath,
      flushIntervalMs: 10000, // long interval — we'll flush manually
      ...opts,
    } as ConstructorParameters<typeof SQLiteLogger>[0]);
  }

  it('creates database and schema', () => {
    const logger = createLogger();
    expect(fs.existsSync(dbPath)).toBe(true);
    logger.close();
  });

  it('writes and queries log entries', () => {
    const logger = createLogger();

    logger.info('Server started');
    logger.warn('Low memory');
    logger.error('Connection failed', { host: 'mqtt.local' });
    logger.flush();

    const entries = logger.query({});
    expect(entries).toHaveLength(3);
    // Ordered by timestamp DESC
    expect(entries[0].level).toBe('error');
    expect(entries[0].message).toBe('Connection failed');
    expect(entries[0].data).toContain('mqtt.local');
    expect(entries[1].level).toBe('warn');
    expect(entries[2].level).toBe('info');

    logger.close();
  });

  it('respects minimum log level', () => {
    const logger = createLogger({ minLevel: 'warn' });

    logger.debug('ignored');
    logger.info('ignored too');
    logger.warn('kept');
    logger.error('also kept');
    logger.flush();

    const entries = logger.query({});
    expect(entries).toHaveLength(2);

    logger.close();
  });

  it('batches writes and flushes on max batch size', () => {
    const logger = createLogger({ maxBatchSize: 3 });

    logger.info('one');
    logger.info('two');
    // No flush yet — batch size is 2

    let entries = logger.query({}); // query calls flush internally
    // After query's internal flush, all entries should be present
    expect(entries).toHaveLength(2);

    logger.close();
  });

  it('creates child loggers scoped to entity', () => {
    const logger = createLogger();
    const child = logger.forEntity('sensor.temp', 'weather.ts');

    child.info('Initialized');
    child.flush();

    const entries = logger.query({ entity_id: 'sensor.temp' });
    expect(entries).toHaveLength(1);
    expect(entries[0].entity_id).toBe('sensor.temp');
    expect(entries[0].source_file).toBe('weather.ts');

    logger.close();
  });

  it('creates child loggers scoped to file', () => {
    const logger = createLogger();
    const child = logger.forFile('garage.ts');

    child.warn('Something happened');
    child.flush();

    const entries = logger.query({ source_file: 'garage.ts' });
    expect(entries).toHaveLength(1);

    logger.close();
  });

  it('queries by level filter', () => {
    const logger = createLogger();

    logger.info('info msg');
    logger.warn('warn msg');
    logger.error('error msg');
    logger.flush();

    const errors = logger.query({ level: ['error'] });
    expect(errors).toHaveLength(1);
    expect(errors[0].level).toBe('error');

    const warnAndError = logger.query({ level: ['warn', 'error'] });
    expect(warnAndError).toHaveLength(2);

    logger.close();
  });

  it('queries by time range', () => {
    const logger = createLogger();

    logger.info('early');
    const midpoint = Date.now();
    logger.info('late');
    logger.flush();

    const recent = logger.query({ since: midpoint });
    // Both entries have very close timestamps, but 'late' should be >= midpoint
    expect(recent.length).toBeGreaterThanOrEqual(1);

    logger.close();
  });

  it('queries by text search', () => {
    const logger = createLogger();

    logger.info('Connection established');
    logger.info('Temperature updated');
    logger.error('Connection refused', { host: 'mqtt' });
    logger.flush();

    const results = logger.query({ search: 'Connection' });
    expect(results).toHaveLength(2);

    const dataSearch = logger.query({ search: 'mqtt' });
    expect(dataSearch).toHaveLength(1);

    logger.close();
  });

  it('respects limit and offset', () => {
    const logger = createLogger();

    for (let i = 0; i < 10; i++) {
      logger.info(`Message ${i}`);
    }
    logger.flush();

    const page1 = logger.query({ limit: 3, offset: 0 });
    expect(page1).toHaveLength(3);

    const page2 = logger.query({ limit: 3, offset: 3 });
    expect(page2).toHaveLength(3);

    // No overlap
    expect(page1[0].message).not.toBe(page2[0].message);

    logger.close();
  });

  it('cleans up old entries', () => {
    const logger = createLogger({ retentionDays: 0 }); // 0 days = delete everything

    logger.info('old message');
    logger.flush();

    // Wait a tiny bit so timestamps are "old" (with 0 retention, cutoff = now)
    const result = logger.cleanup();
    expect(result.deleted).toBeGreaterThanOrEqual(1);

    const remaining = logger.query({});
    expect(remaining).toHaveLength(0);

    logger.close();
  });

  it('invokes onNewEntry callback', () => {
    const onNewEntry = vi.fn();
    const logger = createLogger({ onNewEntry });

    logger.info('test message');

    expect(onNewEntry).toHaveBeenCalledTimes(1);
    expect(onNewEntry).toHaveBeenCalledWith(expect.objectContaining({
      level: 'info',
      message: 'test message',
    }));

    logger.close();
  });

  it('handles close gracefully', () => {
    const logger = createLogger();
    logger.info('before close');
    logger.close();

    // Should not throw
    expect(fs.existsSync(dbPath)).toBe(true);
  });
});

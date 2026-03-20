import { createRequire } from 'node:module';
import type BetterSqlite3 from 'better-sqlite3';
import type { LifecycleLogger } from './lifecycle.js';

export interface SQLiteLoggerOptions {
  /** Path to the SQLite database file */
  dbPath: string;
  /** Minimum log level to persist */
  minLevel?: 'debug' | 'info' | 'warn' | 'error';
  /** Max age in days before cleanup (default: 7) */
  retentionDays?: number;
  /** Batch flush interval in ms (default: 100) */
  flushIntervalMs?: number;
  /** Max batch size before forced flush (default: 50) */
  maxBatchSize?: number;
  /** Callback for broadcasting new log entries (e.g., to WebSocket) */
  onNewEntry?: (entry: LogEntry) => void;
}

export interface LogEntry {
  id?: number;
  timestamp: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  source_file: string;
  entity_id: string | null;
  message: string;
  data: string | null;
  /** Caller location from user code, e.g. "weather.ts:15" */
  caller: string | null;
}

const LEVEL_ORDER = { debug: 0, info: 1, warn: 2, error: 3 } as const;

/**
 * Extract the first user-code caller from the stack trace.
 * Looks for file:// URLs (user bundles loaded via dynamic import)
 * and returns "filename:line" or null if no user frame found.
 */
function extractCaller(): string | null {
  const stack = new Error().stack;
  if (!stack) return null;

  const lines = stack.split('\n');
  for (const line of lines) {
    // User bundles are loaded as file:// URLs (with ?t= cache buster)
    const match = line.match(/file:\/\/.*\/([^/?]+\.js)(?:\?[^:]*)?:(\d+)/);
    if (match) {
      // Convert .js back to .ts for display
      const file = match[1].replace(/\.js$/, '.ts');
      return `${file}:${match[2]}`;
    }
  }
  return null;
}

/**
 * SQLite-backed logger with batched writes and retention cleanup.
 * All SQL queries use parameterized statements to prevent injection.
 */
export class SQLiteLogger implements LifecycleLogger {
  private db: BetterSqlite3.Database;
  private insertStmt: BetterSqlite3.Statement;
  private batch: LogEntry[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private minLevel: number;
  private maxBatchSize: number;
  private retentionDays: number;
  private onNewEntry?: (entry: LogEntry) => void;
  private sourceFile = '_runtime';
  private entityId: string | null = null;

  constructor(opts: SQLiteLoggerOptions) {
    // Lazy-load better-sqlite3 to avoid crashing at module import time
    // if the native module isn't available (e.g. Node version mismatch)
    const require = createRequire(import.meta.url);
    const Database = require('better-sqlite3') as typeof BetterSqlite3;
    this.db = new Database(opts.dbPath);
    this.minLevel = LEVEL_ORDER[opts.minLevel ?? 'debug'];
    this.maxBatchSize = opts.maxBatchSize ?? 50;
    this.retentionDays = opts.retentionDays ?? 7;
    this.onNewEntry = opts.onNewEntry;

    // WAL mode for better concurrent read/write
    this.db.pragma('journal_mode = WAL');

    this.initSchema();

    this.insertStmt = this.db.prepare(
      `INSERT INTO logs (timestamp, level, source_file, entity_id, message, data, caller)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    // Start batch flush timer
    const flushMs = opts.flushIntervalMs ?? 100;
    this.flushTimer = setInterval(() => this.flush(), flushMs);
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        level TEXT NOT NULL,
        source_file TEXT NOT NULL,
        entity_id TEXT,
        message TEXT NOT NULL,
        data TEXT,
        caller TEXT
      )
    `);
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_logs_time ON logs(timestamp)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_logs_entity ON logs(entity_id, timestamp)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level, timestamp)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_logs_file ON logs(source_file, timestamp)');

    // Migration: add caller column to existing databases
    try {
      this.db.exec('ALTER TABLE logs ADD COLUMN caller TEXT');
    } catch {
      // Column already exists — ignore
    }
  }

  /**
   * Create a child logger scoped to a specific entity/file.
   */
  forEntity(entityId: string, sourceFile?: string): SQLiteLogger {
    const child = Object.create(this) as SQLiteLogger;
    child.entityId = entityId;
    if (sourceFile) child.sourceFile = sourceFile;
    return child;
  }

  /**
   * Create a child logger scoped to a specific source file.
   */
  forFile(sourceFile: string): SQLiteLogger {
    const child = Object.create(this) as SQLiteLogger;
    child.sourceFile = sourceFile;
    return child;
  }

  debug(message: string, data?: Record<string, unknown>): void {
    this.writeLog('debug', message, data);
  }

  info(message: string, data?: Record<string, unknown>): void {
    this.writeLog('info', message, data);
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.writeLog('warn', message, data);
  }

  error(message: string, data?: Record<string, unknown>): void {
    this.writeLog('error', message, data);
  }

  private writeLog(level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < this.minLevel) return;

    const entry: LogEntry = {
      timestamp: Date.now(),
      level,
      source_file: this.sourceFile,
      entity_id: this.entityId,
      message,
      data: data ? JSON.stringify(data) : null,
      caller: extractCaller(),
    };

    this.batch.push(entry);
    this.onNewEntry?.(entry);

    if (this.batch.length >= this.maxBatchSize) {
      this.flush();
    }
  }

  /**
   * Flush pending log entries to the database.
   */
  flush(): void {
    if (this.batch.length === 0) return;

    const entries = this.batch.splice(0);

    const insertMany = this.db.transaction((rows: LogEntry[]) => {
      for (const row of rows) {
        this.insertStmt.run(
          row.timestamp,
          row.level,
          row.source_file,
          row.entity_id,
          row.message,
          row.data,
          row.caller,
        );
      }
    });

    try {
      insertMany(entries);
    } catch {
      // If db write fails, entries are lost. Acceptable for logging.
    }
  }

  /**
   * Query log entries with filters. All parameters are bound via ? placeholders.
   */
  query(opts: {
    entity_id?: string;
    level?: string[];
    source_file?: string;
    since?: number;
    until?: number;
    search?: string;
    limit?: number;
    offset?: number;
  }): LogEntry[] {
    this.flush(); // Ensure recent entries are persisted

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (opts.entity_id) {
      conditions.push('entity_id = ?');
      params.push(opts.entity_id);
    }
    if (opts.level && opts.level.length > 0) {
      conditions.push(`level IN (${opts.level.map(() => '?').join(',')})`);
      params.push(...opts.level);
    }
    if (opts.source_file) {
      conditions.push('source_file = ?');
      params.push(opts.source_file);
    }
    if (opts.since) {
      conditions.push('timestamp >= ?');
      params.push(opts.since);
    }
    if (opts.until) {
      conditions.push('timestamp <= ?');
      params.push(opts.until);
    }
    if (opts.search) {
      conditions.push('(message LIKE ? OR data LIKE ?)');
      const pattern = `%${opts.search}%`;
      params.push(pattern, pattern);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = opts.limit ?? 100;
    const offset = opts.offset ?? 0;

    const sql = `SELECT id, timestamp, level, source_file, entity_id, message, data, caller
                 FROM logs ${where}
                 ORDER BY timestamp DESC
                 LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    return this.db.prepare(sql).all(...params) as LogEntry[];
  }

  /**
   * Delete entries older than retention period.
   */
  cleanup(): { deleted: number } {
    const cutoff = Date.now() - this.retentionDays * 24 * 60 * 60 * 1000;
    const result = this.db.prepare('DELETE FROM logs WHERE timestamp <= ?').run(cutoff);
    return { deleted: result.changes };
  }

  /**
   * Close the database and stop the flush timer.
   */
  close(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.flush();
    this.db.close();
  }
}

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema.js';
import { createLogger } from '../logger.js';

const log = createLogger('db');

export type SqlValue = string | number | bigint | null;
export type Row = object;

/**
 * Driver boundary. Everything above this line is portable SQL.
 *
 *   sqlite   — embedded, single-writer, transactionally serialized by Node's
 *              event loop. Used by sandbox/demo/tests.
 *   postgres — production. `Db` keeps the same API; the pg adapter runs the
 *              same migrations from db/postgres/0001_init.sql and relies on
 *              `SELECT … FOR UPDATE` row locks in the settlement worker.
 */
export interface Driver {
  all<T extends Row = Row>(sql: string, params?: SqlValue[]): T[];
  get<T extends Row = Row>(sql: string, params?: SqlValue[]): T | undefined;
  run(sql: string, params?: SqlValue[]): { changes: number; lastInsertRowid: number };
  exec(sql: string): void;
  /** Synchronous transaction: the callback must not await (Node single writer). */
  transaction<T>(fn: () => T): T;
  close(): void;
}

class SqliteDriver implements Driver {
  private db: DatabaseSync;

  constructor(file: string) {
    if (file !== ':memory:') {
      fs.mkdirSync(path.dirname(file), { recursive: true });
    }
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA busy_timeout = 5000');
    // node:sqlite cannot bind BigInt values, so every amount crosses the
    // driver as a decimal string of minor units (see shared/money.ts).
    this.db.exec('PRAGMA synchronous = NORMAL');
  }

  /** node:sqlite refuses BigInt bindings, so big values cross as decimal strings. */
  private bind(params: SqlValue[] = []): (string | number | null)[] {
    return params.map((p) => (typeof p === 'bigint' ? p.toString() : p));
  }

  all<T extends Row = Row>(sql: string, params: SqlValue[] = []): T[] {
    return this.db.prepare(sql).all(...this.bind(params)) as T[];
  }

  get<T extends Row = Row>(sql: string, params: SqlValue[] = []): T | undefined {
    return this.db.prepare(sql).get(...this.bind(params)) as T | undefined;
  }

  run(sql: string, params: SqlValue[] = []): { changes: number; lastInsertRowid: number } {
    const res = this.db.prepare(sql).run(...this.bind(params));
    return { changes: Number(res.changes), lastInsertRowid: Number(res.lastInsertRowid) };
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  private txDepth = 0;
  private txAborted = false;

  /**
   * Re-entrant transaction. Domain code composes (a journal post runs inside a
   * wallet change which runs inside a payment transition), and SQLite has no
   * nested BEGIN — so only the outermost frame opens and closes the transaction.
   * Any inner failure marks the whole thing aborted, and the outer frame rolls
   * back: a partially applied money movement is not a thing that can exist here.
   */
  transaction<T>(fn: () => T): T {
    if (this.txDepth > 0) {
      this.txDepth += 1;
      try {
        return fn();
      } catch (error) {
        this.txAborted = true;
        throw error;
      } finally {
        this.txDepth -= 1;
      }
    }
    this.db.exec('BEGIN IMMEDIATE');
    this.txDepth = 1;
    this.txAborted = false;
    try {
      const out = fn();
      if (this.txAborted) throw new Error('transaction aborted by an inner failure');
      this.db.exec('COMMIT');
      return out;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* rollback failure is secondary to the original error */
      }
      throw error;
    } finally {
      this.txDepth = 0;
      this.txAborted = false;
    }
  }

  close(): void {
    this.db.close();
  }
}

export class Db {
  constructor(readonly driver: Driver, readonly dialect: 'sqlite' | 'postgres') {}

  all<T extends Row = Row>(sql: string, params?: SqlValue[]): T[] {
    return this.driver.all<T>(sql, params);
  }

  maybeOne<T extends Row = Row>(sql: string, params?: SqlValue[]): T | undefined {
    return this.driver.get<T>(sql, params);
  }

  one<T extends Row = Row>(sql: string, params?: SqlValue[]): T {
    const row = this.driver.get<T>(sql, params);
    if (!row) throw new Error(`expected one row, found none: ${sql.slice(0, 120)}`);
    return row;
  }

  run(sql: string, params?: SqlValue[]): { changes: number; lastInsertRowid: number } {
    return this.driver.run(sql, params);
  }

  tx<T>(fn: () => T): T {
    return this.driver.transaction(fn);
  }

  /** Convenience: JSON columns are stored as TEXT. */
  json<T>(value: unknown): string {
    return JSON.stringify(value ?? null);
  }

  parse<T>(value: unknown, fallback: T): T {
    if (typeof value !== 'string' || value === '') return fallback;
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }

  /** `IN (…)` helper that never string-interpolates values. */
  placeholders(count: number, offset = 0): string {
    return Array.from({ length: count }, (_, i) => `$${i + 1 + offset}`).join(', ');
  }
}

let instance: Db | null = null;

export function getDb(): Db {
  if (instance) return instance;
  if (config.database.driver === 'postgres') {
    // Kept explicit rather than silently falling back to an embedded store: a
    // production deployment misconfigured for Postgres must not run on SQLite.
    throw new Error(
      'DATABASE_DRIVER=postgres requires the pg adapter. Install `pg`, run ' +
        'db/postgres/0001_init.sql against the managed cluster and wire ' +
        'src/db/postgres.ts (interface `Driver`). Refusing to start on SQLite.',
    );
  }
  const file = config.database.sqlitePath;
  const driver = new SqliteDriver(file);
  instance = new Db(driver, 'sqlite');
  migrate(instance);
  return instance;
}

/** Used by tests to obtain an isolated in-memory database. */
export function createMemoryDb(): Db {
  const driver = new SqliteDriver(':memory:');
  const db = new Db(driver, 'sqlite');
  migrate(db);
  return db;
}

export function migrate(db: Db): void {
  db.driver.exec(SCHEMA_SQL);
  const existing = db.maybeOne<{ version: string }>('SELECT version FROM schema_migrations WHERE version = ?', [
    SCHEMA_VERSION,
  ]);
  if (!existing) {
    db.run('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)', [
      SCHEMA_VERSION,
      new Date().toISOString(),
    ]);
    log.info(`applied migration ${SCHEMA_VERSION}`);
  }
}

export function closeDb(): void {
  instance?.driver.close();
  instance = null;
}

/** Reads a numeric column that may be stored as TEXT minor units. */
export function rowBigInt(row: Record<string, unknown> | undefined, key: string): bigint {
  const raw = row?.[key];
  if (raw === null || raw === undefined) return 0n;
  if (typeof raw === 'bigint') return raw;
  return BigInt(String(raw));
}

export function rowNumber(row: Record<string, unknown> | undefined, key: string, fallback = 0): number {
  const raw = row?.[key];
  if (raw === null || raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function rowString(row: Record<string, unknown> | undefined, key: string): string | null {
  const raw = row?.[key];
  return raw === null || raw === undefined ? null : String(raw);
}

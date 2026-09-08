import { config } from '../config.js';
import { id, nowIso } from '../lib/ids.js';
import { stringify } from '../lib/json.js';
import { getDb } from './index.js';

/**
 * Tiny insert/update helpers built from the record itself.
 *
 * Every money-moving table here has 20–40 columns, and a hand-written
 * `INSERT … VALUES (?,?,?)` list is exactly the kind of code that silently
 * shifts by one placeholder and corrupts nothing but *meaning* (a fee landing in
 * the recipient column). Building the statement from the object removes that
 * failure mode, keeps call sites readable, and is what the domain modules use.
 *
 * Column names are taken from this module's own key lists, never from user
 * input, so the identifier interpolation below is not an injection surface.
 */

export type RowData = Record<string, string | number | bigint | boolean | null | undefined>;

function value(input: unknown): string | number | null {
  if (input === undefined || input === null) return null;
  if (typeof input === 'boolean') return input ? 1 : 0;
  if (typeof input === 'bigint') return input.toString();
  if (typeof input === 'object') return JSON.stringify(input);
  return input as string | number;
}

export function insert(table: string, data: RowData): void {
  const keys = Object.keys(data);
  if (!keys.length) throw new Error(`insert(${table}): nothing to write`);
  getDb().run(
    `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
    keys.map((k) => value(data[k])),
  );
}

/** `INSERT OR IGNORE` for rows guarded by a UNIQUE constraint (e.g. tx hashes). */
export function insertIgnore(table: string, data: RowData): void {
  const keys = Object.keys(data);
  getDb().run(
    `INSERT OR IGNORE INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
    keys.map((k) => value(data[k])),
  );
}

export function insertReturningId<T extends RowData & { id: string }>(table: string, data: T): string {
  insert(table, data);
  return data.id;
}

/** Update by primary key. `undefined` values are skipped, `null` clears. */
export function update(table: string, idValue: string, data: RowData): void {
  const keys = Object.keys(data).filter((k) => data[k] !== undefined);
  if (!keys.length) return;
  getDb().run(
    `UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
    [...keys.map((k) => value(data[k])), idValue],
  );
}

/** Upsert used by settings/config style tables. */
export function upsert(table: string, conflictColumns: string[], data: RowData): void {
  const keys = Object.keys(data);
  const conflicts = conflictColumns.join(', ');
  const updates = keys.filter((k) => !conflictColumns.includes(k));
  getDb().run(
    `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})${
      updates.length ? ` ON CONFLICT (${conflicts}) DO UPDATE SET ${updates.map((k) => `${k} = excluded.${k}`).join(', ')}` : ' ON CONFLICT (' + conflicts + ') DO NOTHING'
    }`,
    keys.map((k) => value(data[k])),
  );
}


/**
 * Arm the one audited exception to the append-only triggers, run `fn`, then disarm
 * it. Sandbox demo corpora need backdated *timestamps* to look like real history;
 * nothing here can change an amount, a state or a direction, and outside sandbox
 * mode the function refuses to run at all. The arming itself is written to
 * audit_logs so the exception leaves a trace like everything else.
 */
export function withSeedBypass<T>(reason: string, fn: () => T): T {
  const db = getDb();
  if (!config.isSandbox) {
    throw new Error('the append-only bypass is refused outside sandbox mode');
  }
  db.tx(() => {
    db.run('INSERT OR REPLACE INTO seed_lock (id, reason, armed_at) VALUES (1, ?, ?)', [reason, nowIso()]);
    db.run(
      `INSERT INTO audit_logs (id, actor_user_id, actor_type, action, target_type, target_id, metadata, created_at)
       VALUES (?, NULL, 'SYSTEM', 'APPEND_ONLY_BYPASS_ARMED', 'database', 'seed_lock', ?, ?)`,
      [id('aud'), stringify({ reason }), nowIso()],
    );
  });
  try {
    return fn();
  } finally {
    db.tx(() => {
      db.run('DELETE FROM seed_lock');
      db.run(
        `INSERT INTO audit_logs (id, actor_user_id, actor_type, action, target_type, target_id, metadata, created_at)
         VALUES (?, NULL, 'SYSTEM', 'APPEND_ONLY_BYPASS_DISARMED', 'database', 'seed_lock', ?, ?)`,
        [id('aud'), stringify({ reason }), nowIso()],
      );
    });
  }
}

/**
 * ddlforge - Migration Safety Ledger
 *
 * Implements persistent recording of disaster recovery health, RPO compliance,
 * and restore verification results in `ddlforge.migration_safety_log`.
 */

import type { PgClientLike } from '../cluster/advisory.js';

export interface SafetyLogEntry {
  eventType: 'doctor_check' | 'restore_verification' | 'rpo_audit' | 'migration_preflight' | string;
  targetIdentifier: string;
  status: 'PASSED' | 'FAILED' | 'WARNING';
  details: Record<string, any>;
}

export interface SafetyLogRecord extends SafetyLogEntry {
  id: number;
  createdAt: Date;
}

/**
 * Ensures the `ddlforge.migration_safety_log` table exists in PostgreSQL.
 */
export async function ensureSafetyLedgerTable(client: PgClientLike): Promise<void> {
  const ddl = `
    CREATE SCHEMA IF NOT EXISTS ddlforge;
    CREATE TABLE IF NOT EXISTS ddlforge.migration_safety_log (
      id SERIAL PRIMARY KEY,
      event_type VARCHAR(64) NOT NULL,
      target_identifier VARCHAR(255) NOT NULL,
      status VARCHAR(32) NOT NULL,
      details JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_ddlforge_safety_log_event
      ON ddlforge.migration_safety_log (event_type, created_at DESC);
  `;

  await client.query(ddl);
}

/**
 * Records a safety audit or verification event in the migration safety ledger.
 * Defensively handles permission issues or failures so logging never crashes callers unexpectedly.
 */
export async function recordSafetyLog(
  client: PgClientLike,
  entry: SafetyLogEntry
): Promise<number | null> {
  try {
    await ensureSafetyLedgerTable(client);

    const sql = `
      INSERT INTO ddlforge.migration_safety_log (event_type, target_identifier, status, details)
      VALUES ($1, $2, $3, $4::jsonb)
      RETURNING id;
    `;

    const res = await client.query(sql, [
      entry.eventType,
      entry.targetIdentifier,
      entry.status,
      JSON.stringify(entry.details),
    ]);

    return res.rows[0]?.id ?? null;
  } catch (err: any) {
    // Non-fatal warning if ledger insert fails (e.g. read-only replica or insufficient privileges)
    return null;
  }
}

/**
 * Queries recent entries from the migration safety ledger.
 */
export async function querySafetyLog(
  client: PgClientLike,
  options: { limit?: number; eventType?: string } = {}
): Promise<SafetyLogRecord[]> {
  const limit = options.limit ?? 20;

  try {
    let sql = `
      SELECT id, event_type, target_identifier, status, details, created_at
      FROM ddlforge.migration_safety_log
    `;
    const params: unknown[] = [];

    if (options.eventType) {
      params.push(options.eventType);
      sql += ` WHERE event_type = $1`;
    }

    sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1};`;
    params.push(limit);

    const res = await client.query(sql, params);
    return res.rows.map(row => ({
      id: row.id,
      eventType: row.event_type,
      targetIdentifier: row.target_identifier,
      status: row.status,
      details: typeof row.details === 'string' ? JSON.parse(row.details) : row.details,
      createdAt: new Date(row.created_at),
    }));
  } catch {
    return [];
  }
}

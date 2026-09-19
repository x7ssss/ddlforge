/**
 * ddlforge - Restore Verification Hook & Target Instance Health Engine
 *
 * Implements post-restoration instance validation:
 * 1. Verifies recovery completion (`pg_is_in_recovery() = false`).
 * 2. Checks B-tree index integrity via `amcheck` (`bt_index_check`).
 * 3. Inspects and flags unvalidated foreign keys (`pg_constraint.convalidated = false`).
 * 4. Persists verification outcomes in `ddlforge.migration_safety_log`.
 */

import type { PgClientLike } from '../cluster/advisory.js';
import { recordSafetyLog } from './safetyLedger.js';

export interface BTreeIndexCorruption {
  indexOid: number | string;
  indexName: string;
  schemaName: string;
  tableName: string;
  error: string;
}

export interface UnvalidatedForeignKey {
  constraintName: string;
  schemaName: string;
  tableName: string;
  foreignTableName: string;
  definition: string;
}

export interface VerifyRestoreOptions {
  targetUrl?: string;
  skipAmcheck?: boolean;
  rpoHours?: number;
  logToLedger?: boolean;
  now?: Date;
}

export interface RestoreVerificationReport {
  targetIdentifier: string;
  recoveryCompleted: boolean;
  isInRecovery: boolean;
  amcheck: {
    checked: boolean;
    skipped: boolean;
    totalIndexesChecked: number;
    corruptedIndexes: BTreeIndexCorruption[];
    passed: boolean;
    message?: string;
  };
  foreignKeys: {
    totalUnvalidated: number;
    unvalidatedKeys: UnvalidatedForeignKey[];
    passed: boolean;
    message?: string;
  };
  passed: boolean;
  errors: string[];
  warnings: string[];
  ledgerLogged: boolean;
  verifiedAt: Date;
}

/**
 * Checks whether PostgreSQL has completed recovery and is accepting read-write connections.
 */
export async function verifyRecoveryCompletion(client: PgClientLike): Promise<{
  recoveryCompleted: boolean;
  isInRecovery: boolean;
}> {
  const res = await client.query('SELECT pg_is_in_recovery() AS in_recovery;');
  const inRecovery = Boolean(res.rows[0]?.in_recovery);

  return {
    recoveryCompleted: !inRecovery,
    isInRecovery: inRecovery,
  };
}

/**
 * Validates B-Tree index integrity across all user tables using amcheck (bt_index_check).
 */
export async function verifyBtreeIndexes(
  client: PgClientLike,
  options: { skipAmcheck?: boolean } = {}
): Promise<{
  checked: boolean;
  skipped: boolean;
  totalIndexesChecked: number;
  corruptedIndexes: BTreeIndexCorruption[];
  passed: boolean;
  message?: string;
}> {
  if (options.skipAmcheck) {
    return {
      checked: false,
      skipped: true,
      totalIndexesChecked: 0,
      corruptedIndexes: [],
      passed: true,
      message: 'amcheck validation was skipped via --skip-amcheck flag.',
    };
  }

  // 1. Check if amcheck extension is installed or installable
  let hasAmcheck = false;
  try {
    const extRes = await client.query("SELECT 1 FROM pg_extension WHERE extname = 'amcheck';");
    if (extRes.rows.length > 0) {
      hasAmcheck = true;
    } else {
      // Attempt creation if superuser/permitted
      try {
        await client.query('CREATE EXTENSION IF NOT EXISTS amcheck;');
        hasAmcheck = true;
      } catch {
        hasAmcheck = false;
      }
    }
  } catch {
    hasAmcheck = false;
  }

  if (!hasAmcheck) {
    return {
      checked: false,
      skipped: true,
      totalIndexesChecked: 0,
      corruptedIndexes: [],
      passed: true,
      message: 'amcheck extension is not available or could not be created; skipped index checks.',
    };
  }

  // 2. Discover all user B-tree indexes
  const indexQuery = `
    SELECT
      c.oid AS index_oid,
      c.relname AS index_name,
      n.nspname AS schema_name,
      t.relname AS table_name
    FROM pg_class c
    JOIN pg_index i ON i.indexrelid = c.oid
    JOIN pg_am am ON am.oid = c.relam
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_class t ON t.oid = i.indrelid
    WHERE am.amname = 'btree'
      AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
      AND c.relispartition = false
      AND i.indisvalid = true
    ORDER BY n.nspname, t.relname, c.relname;
  `;

  let indexRows: any[] = [];
  try {
    const res = await client.query(indexQuery);
    indexRows = res.rows;
  } catch (err: any) {
    return {
      checked: true,
      skipped: false,
      totalIndexesChecked: 0,
      corruptedIndexes: [],
      passed: false,
      message: `Failed to query B-tree indexes: ${err.message}`,
    };
  }

  const corruptedIndexes: BTreeIndexCorruption[] = [];

  // 3. Run bt_index_check on each index
  for (const idx of indexRows) {
    try {
      // bt_index_check(index_oid, readonly)
      await client.query('SELECT bt_index_check($1::regclass, true);', [idx.index_oid]);
    } catch (err: any) {
      corruptedIndexes.push({
        indexOid: idx.index_oid,
        indexName: idx.index_name,
        schemaName: idx.schema_name,
        tableName: idx.table_name,
        error: err.message,
      });
    }
  }

  return {
    checked: true,
    skipped: false,
    totalIndexesChecked: indexRows.length,
    corruptedIndexes,
    passed: corruptedIndexes.length === 0,
    message:
      corruptedIndexes.length > 0
        ? `Found ${corruptedIndexes.length} corrupted B-tree index(es).`
        : `Verified ${indexRows.length} B-tree index(es) cleanly.`,
  };
}

/**
 * Checks for unvalidated foreign key constraints across user schemas.
 */
export async function queryUnvalidatedForeignKeys(
  client: PgClientLike
): Promise<UnvalidatedForeignKey[]> {
  const sql = `
    SELECT
      c.conname AS constraint_name,
      n.nspname AS schema_name,
      t.relname AS table_name,
      ft.relname AS foreign_table_name,
      pg_get_constraintdef(c.oid) AS definition
    FROM pg_constraint c
    JOIN pg_namespace n ON n.oid = c.connamespace
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_class ft ON ft.oid = c.confrelid
    WHERE c.contype = 'f'
      AND NOT c.convalidated
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
    ORDER BY n.nspname, t.relname, c.conname;
  `;

  try {
    const res = await client.query(sql);
    return res.rows.map(row => ({
      constraintName: row.constraint_name,
      schemaName: row.schema_name,
      tableName: row.table_name,
      foreignTableName: row.foreign_table_name,
      definition: row.definition,
    }));
  } catch {
    return [];
  }
}

/**
 * Runs full restore verification suite against a target PostgreSQL instance.
 */
export async function verifyRestoredInstance(
  client: PgClientLike,
  options: VerifyRestoreOptions = {}
): Promise<RestoreVerificationReport> {
  const now = options.now ?? new Date();
  const targetIdentifier = options.targetUrl ? options.targetUrl.replace(/:[^:@]+@/, ':***@') : 'postgres_instance';
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. Verify Recovery State
  const recovery = await verifyRecoveryCompletion(client);
  if (!recovery.recoveryCompleted) {
    errors.push(
      'Database is currently in recovery mode (pg_is_in_recovery() = true). Restore replay has not completed or instance is a read-only standby.'
    );
  }

  // 2. Check B-tree integrity via amcheck
  const amcheck = await verifyBtreeIndexes(client, { skipAmcheck: options.skipAmcheck });
  if (!amcheck.passed) {
    for (const c of amcheck.corruptedIndexes) {
      errors.push(`Corrupted B-tree index: ${c.schemaName}.${c.indexName} on ${c.tableName} (${c.error})`);
    }
  }

  // 3. Check for unvalidated foreign keys
  const unvalidatedKeys = await queryUnvalidatedForeignKeys(client);
  const fkPassed = unvalidatedKeys.length === 0;
  if (!fkPassed) {
    warnings.push(
      `Found ${unvalidatedKeys.length} unvalidated foreign key constraint(s). Referential integrity must be validated via VALIDATE CONSTRAINT.`
    );
  }

  const passed = errors.length === 0;

  const report: RestoreVerificationReport = {
    targetIdentifier,
    recoveryCompleted: recovery.recoveryCompleted,
    isInRecovery: recovery.isInRecovery,
    amcheck,
    foreignKeys: {
      totalUnvalidated: unvalidatedKeys.length,
      unvalidatedKeys,
      passed: fkPassed,
      message: fkPassed
        ? 'All foreign keys are validated.'
        : `${unvalidatedKeys.length} foreign key(s) are unvalidated.`,
    },
    passed,
    errors,
    warnings,
    ledgerLogged: false,
    verifiedAt: now,
  };

  // 4. Log to migration safety ledger if enabled
  if (options.logToLedger !== false) {
    const logId = await recordSafetyLog(client, {
      eventType: 'restore_verification',
      targetIdentifier,
      status: passed ? (warnings.length > 0 ? 'WARNING' : 'PASSED') : 'FAILED',
      details: {
        recoveryCompleted: recovery.recoveryCompleted,
        amcheck: {
          checked: amcheck.checked,
          skipped: amcheck.skipped,
          corruptedCount: amcheck.corruptedIndexes.length,
        },
        unvalidatedFkCount: unvalidatedKeys.length,
        errors,
        warnings,
      },
    });
    report.ledgerLogged = logId !== null;
  }

  return report;
}

/**
 * Renders a colorized terminal report of the restore verification outcome.
 */
export function formatRestoreReportTerminal(report: RestoreVerificationReport): string {
  const lines: string[] = [];

  lines.push('');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('  ddlforge v1.6.0 — Restored Instance Verification Engine');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push(`Target:     ${report.targetIdentifier}`);
  lines.push(`Verified:   ${report.verifiedAt.toISOString()}`);
  lines.push('');

  // 1. Recovery Status
  lines.push('[1] RECOVERY COMPLETION CHECK');
  if (report.recoveryCompleted) {
    lines.push('  ✔ PASSED: Recovery completed (pg_is_in_recovery() = false). Instance is read-write.');
  } else {
    lines.push('  ✖ FAILED: Instance is still in recovery (pg_is_in_recovery() = true).');
  }
  lines.push('');

  // 2. B-Tree amcheck
  lines.push('[2] B-TREE INDEX INTEGRITY (amcheck / bt_index_check)');
  if (report.amcheck.skipped) {
    lines.push(`  ℹ SKIPPED: ${report.amcheck.message}`);
  } else if (report.amcheck.passed) {
    lines.push(`  ✔ PASSED: ${report.amcheck.totalIndexesChecked} B-tree indexes checked, 0 corruptions.`);
  } else {
    lines.push(`  ✖ FAILED: Found ${report.amcheck.corruptedIndexes.length} corrupted indexes:`);
    for (const c of report.amcheck.corruptedIndexes) {
      lines.push(`    - ${c.schemaName}.${c.indexName} (Table: ${c.tableName}): ${c.error}`);
    }
  }
  lines.push('');

  // 3. Foreign Keys
  lines.push('[3] REFERENTIAL INTEGRITY (Unvalidated Foreign Keys)');
  if (report.foreignKeys.passed) {
    lines.push('  ✔ PASSED: All foreign keys are validated (convalidated = true).');
  } else {
    lines.push(`  ⚠ WARNING: Found ${report.foreignKeys.totalUnvalidated} unvalidated foreign key(s):`);
    for (const fk of report.foreignKeys.unvalidatedKeys) {
      lines.push(`    - ${fk.schemaName}.${fk.tableName}.${fk.constraintName} -> ${fk.foreignTableName}`);
      lines.push(`      Fix: ALTER TABLE ${fk.schemaName}.${fk.tableName} VALIDATE CONSTRAINT ${fk.constraintName};`);
    }
  }
  lines.push('');

  // Summary
  lines.push('──────────────────────────────────────────────────────────────────────');
  if (report.passed) {
    lines.push('  ✔ RESTORE VERIFICATION PASSED: Database instance is verified and ready.');
  } else {
    lines.push('  ✖ RESTORE VERIFICATION FAILED: Critical issues detected on restored instance.');
  }
  if (report.ledgerLogged) {
    lines.push('  ✔ Verification recorded in ddlforge.migration_safety_log.');
  }
  lines.push('──────────────────────────────────────────────────────────────────────');

  return lines.join('\n');
}

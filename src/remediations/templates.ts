/**
 * ddlforge - Zero-Downtime Migration Remediation Engine Templates
 *
 * Implements multi-phase zero-downtime remediation generators for high-risk
 * PostgreSQL DDL operations, enforcing SET LOCAL lock_timeout = '2s' inside
 * transactional blocks and throttled resumable backfills (LIMIT 5000 + pg_sleep(0.1)).
 */

import {
  NotNullColumnAdditionParams,
  UnvalidatedForeignKeyParams,
  PrimaryKeyMissingUsingIndexParams,
  ColumnTypeRewriteParams,
  RemediationPhase,
  RemediationRecipe,
} from './types.js';

function cleanIdentifier(id: string): string {
  return id.replace(/["`]/g, '');
}

/**
 * Builds formatted multi-phase SQL text from phases.
 */
function assembleFullSql(title: string, phases: RemediationPhase[]): string {
  const chunks: string[] = [`-- ══════════════════════════════════════════════════════════════════════`,
    `-- Zero-Downtime Migration Recipe: ${title}`,
    `-- ══════════════════════════════════════════════════════════════════════`];

  for (const p of phases) {
    chunks.push('');
    chunks.push(`-- Phase ${p.phase}: ${p.title}`);
    chunks.push(`-- Description: ${p.description}`);
    if (p.transactional) {
      chunks.push(`-- Execution: Must be run inside a transaction block with lock_timeout`);
    } else {
      chunks.push(`-- Execution: Must run OUTSIDE an explicit transaction block (autocommit)`);
    }
    chunks.push(p.sql);
  }

  return chunks.join('\n');
}

/**
 * 1. Remediation builder for `not-null-column-addition`:
 * - Phase 1: Add column as nullable with NOT VALID check constraint (lock_timeout 2s)
 * - Phase 2: Resumable throttled backfill procedure with LIMIT 5000 and PERFORM pg_sleep(0.1)
 * - Phase 3: Validate check constraint, O(1) SET NOT NULL under lock_timeout, drop check constraint
 */
export function buildNotNullColumnRemediation(
  params: NotNullColumnAdditionParams
): RemediationRecipe {
  const table = cleanIdentifier(params.table);
  const column = cleanIdentifier(params.column);
  const colType = params.type || 'TEXT';
  const defaultVal = params.defaultValue !== undefined ? params.defaultValue : `'default_value'`;
  const chkName = `chk_${table}_${column}_not_null`;

  const phases: RemediationPhase[] = [
    {
      phase: 1,
      title: 'Add column nullable + NOT VALID check constraint',
      description:
        'Adds the column without NOT NULL so existing rows are unaffected. Adds a NOT VALID check constraint to enforce NOT NULL for new writes without scanning existing table rows.',
      transactional: true,
      sql: `BEGIN;
SET LOCAL lock_timeout = '2s';
ALTER TABLE ${table} ADD COLUMN ${column} ${colType};
ALTER TABLE ${table} ADD CONSTRAINT ${chkName} CHECK (${column} IS NOT NULL) NOT VALID;
COMMIT;`,
    },
    {
      phase: 2,
      title: 'Resumable throttled batch backfill',
      description:
        'Backfills existing NULL rows in small batches of 5000 with a 100ms pause between batches to minimize lock contention and replication lag.',
      transactional: false,
      sql: `DO $$
DECLARE
  rows_updated INT;
BEGIN
  LOOP
    UPDATE ${table}
    SET ${column} = ${defaultVal}
    WHERE ctid IN (
      SELECT ctid FROM ${table}
      WHERE ${column} IS NULL
      LIMIT 5000
    );
    GET DIAGNOSTICS rows_updated = ROW_COUNT;
    EXIT WHEN rows_updated = 0;
    PERFORM pg_sleep(0.1);
    COMMIT;
  END LOOP;
END $$;`,
    },
    {
      phase: 3,
      title: 'Validate check constraint and apply O(1) SET NOT NULL',
      description:
        'Validates the check constraint using a non-exclusive table scan. Once validated, Postgres 12+ applies SET NOT NULL as an instantaneous O(1) catalog metadata update.',
      transactional: false,
      sql: `ALTER TABLE ${table} VALIDATE CONSTRAINT ${chkName};

BEGIN;
SET LOCAL lock_timeout = '2s';
ALTER TABLE ${table} ALTER COLUMN ${column} SET NOT NULL;
ALTER TABLE ${table} DROP CONSTRAINT ${chkName};
COMMIT;`,
    },
  ];

  return {
    ruleId: 'not-null-column-addition',
    title: `Safe NOT NULL Column Addition on "${table}"."${column}"`,
    phases,
    fullSql: assembleFullSql(`Safe NOT NULL Column Addition on "${table}"."${column}"`, phases),
  };
}

/**
 * 2. Remediation builder for `unvalidated-foreign-key`:
 * - Phase 1: ADD CONSTRAINT ... FOREIGN KEY ... NOT VALID (lock_timeout 2s)
 * - Phase 2: Isolated VALIDATE CONSTRAINT (outside exclusive transaction)
 */
export function buildUnvalidatedForeignKeyRemediation(
  params: UnvalidatedForeignKeyParams
): RemediationRecipe {
  const table = cleanIdentifier(params.table);
  const column = cleanIdentifier(params.column);
  const fTable = cleanIdentifier(params.foreignTable);
  const fCol = cleanIdentifier(params.foreignColumn);
  const constraintName = params.constraintName
    ? cleanIdentifier(params.constraintName)
    : `fk_${table}_${column}`;

  const phases: RemediationPhase[] = [
    {
      phase: 1,
      title: 'Add foreign key constraint as NOT VALID',
      description:
        'Adds the foreign key with NOT VALID to immediately enforce referential integrity on new writes while skipping the expensive initial full-table scan.',
      transactional: true,
      sql: `BEGIN;
SET LOCAL lock_timeout = '2s';
ALTER TABLE ${table} ADD CONSTRAINT ${constraintName} FOREIGN KEY (${column}) REFERENCES ${fTable} (${fCol}) NOT VALID;
COMMIT;`,
    },
    {
      phase: 2,
      title: 'Validate foreign key constraint in isolation',
      description:
        'Validates the foreign key constraint across existing rows under a SHARE UPDATE EXCLUSIVE lock, allowing concurrent reads and writes (INSERT, UPDATE, DELETE).',
      transactional: false,
      sql: `ALTER TABLE ${table} VALIDATE CONSTRAINT ${constraintName};`,
    },
  ];

  return {
    ruleId: 'unvalidated-foreign-key',
    title: `Two-Phase Foreign Key Addition on "${table}"."${column}"`,
    phases,
    fullSql: assembleFullSql(`Two-Phase Foreign Key Addition on "${table}"."${column}"`, phases),
  };
}

/**
 * 3. Remediation builder for `primary-key-missing-using-index`:
 * - Phase 1: Isolated autocommit CREATE UNIQUE INDEX CONCURRENTLY
 * - Phase 2: ADD CONSTRAINT ... PRIMARY KEY USING INDEX (lock_timeout 2s)
 */
export function buildPrimaryKeyUsingIndexRemediation(
  params: PrimaryKeyMissingUsingIndexParams
): RemediationRecipe {
  const table = cleanIdentifier(params.table);
  const cols = Array.isArray(params.columns) ? params.columns.join(', ') : params.columns;
  const rawColClean = cols.replace(/[^a-zA-Z0-9_]/g, '_');
  const indexName = params.indexName
    ? cleanIdentifier(params.indexName)
    : `idx_${table}_${rawColClean}_pk`;
  const constraintName = params.constraintName
    ? cleanIdentifier(params.constraintName)
    : `pk_${table}`;

  const phases: RemediationPhase[] = [
    {
      phase: 1,
      title: 'Create unique index concurrently',
      description:
        'Builds the supporting unique index in the background without locking the table against concurrent writes (INSERT, UPDATE, DELETE). Must run outside a transaction.',
      transactional: false,
      sql: `CREATE UNIQUE INDEX CONCURRENTLY ${indexName} ON ${table} (${cols});`,
    },
    {
      phase: 2,
      title: 'Attach index as PRIMARY KEY constraint',
      description:
        'Attaches the pre-built index to establish the PRIMARY KEY constraint instantaneously via metadata update without rescanning table data.',
      transactional: true,
      sql: `BEGIN;
SET LOCAL lock_timeout = '2s';
ALTER TABLE ${table} ADD CONSTRAINT ${constraintName} PRIMARY KEY USING INDEX ${indexName};
COMMIT;`,
    },
  ];

  return {
    ruleId: 'primary-key-missing-using-index',
    title: `Zero-Downtime Primary Key Addition on "${table}" (${cols})`,
    phases,
    fullSql: assembleFullSql(`Zero-Downtime Primary Key Addition on "${table}" (${cols})`, phases),
  };
}

/**
 * 4. Remediation builder for `column-type-rewrite`:
 * - Phase 1: Shadow column + BEFORE sync trigger (lock_timeout 2s)
 * - Phase 2: Resumable batch backfill procedure (LIMIT 5000 + pg_sleep(0.1))
 * - Phase 3: Atomic column rename swap (lock_timeout 2s)
 */
export function buildColumnTypeRewriteRemediation(
  params: ColumnTypeRewriteParams
): RemediationRecipe {
  const table = cleanIdentifier(params.table);
  const column = cleanIdentifier(params.column);
  const newType = params.newType;
  const shadowCol = params.shadowColumn ? cleanIdentifier(params.shadowColumn) : `${column}_new`;
  const fnName = params.functionName ? cleanIdentifier(params.functionName) : `sync_${table}_${shadowCol}`;
  const trgName = params.triggerName ? cleanIdentifier(params.triggerName) : `trg_sync_${table}_${shadowCol}`;

  const phases: RemediationPhase[] = [
    {
      phase: 1,
      title: 'Create shadow column and dual-write trigger',
      description:
        'Adds a shadow column with the target type and sets up a BEFORE trigger to replicate new writes and updates into the shadow column.',
      transactional: true,
      sql: `BEGIN;
SET LOCAL lock_timeout = '2s';
ALTER TABLE ${table} ADD COLUMN ${shadowCol} ${newType};

CREATE OR REPLACE FUNCTION ${fnName}()
RETURNS TRIGGER AS $$
BEGIN
  NEW.${shadowCol} := NEW.${column}::${newType};
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ${trgName}
  BEFORE INSERT OR UPDATE ON ${table}
  FOR EACH ROW
  EXECUTE FUNCTION ${fnName}();
COMMIT;`,
    },
    {
      phase: 2,
      title: 'Resumable throttled batch backfill',
      description:
        'Backfills existing historical rows in batches of 5000 with a 100ms pause to prevent replication lag and buffer pool churn.',
      transactional: false,
      sql: `DO $$
DECLARE
  rows_updated INT;
BEGIN
  LOOP
    UPDATE ${table}
    SET ${shadowCol} = ${column}::${newType}
    WHERE ctid IN (
      SELECT ctid FROM ${table}
      WHERE ${shadowCol} IS NULL
      LIMIT 5000
    );
    GET DIAGNOSTICS rows_updated = ROW_COUNT;
    EXIT WHEN rows_updated = 0;
    PERFORM pg_sleep(0.1);
    COMMIT;
  END LOOP;
END $$;`,
    },
    {
      phase: 3,
      title: 'Atomic rename swap and cleanup',
      description:
        'Drops the dual-write trigger and swaps column names atomically under a 2-second lock timeout.',
      transactional: true,
      sql: `BEGIN;
SET LOCAL lock_timeout = '2s';
DROP TRIGGER ${trgName} ON ${table};
DROP FUNCTION ${fnName}();
ALTER TABLE ${table} RENAME COLUMN ${column} TO ${column}_old;
ALTER TABLE ${table} RENAME COLUMN ${shadowCol} TO ${column};
COMMIT;
-- Optional Phase 4 (after application deploy verifies stability):
-- ALTER TABLE ${table} DROP COLUMN ${column}_old;`,
    },
  ];

  return {
    ruleId: 'column-type-rewrite',
    title: `Zero-Downtime Column Type Migration for "${table}"."${column}" to ${newType}`,
    phases,
    fullSql: assembleFullSql(
      `Zero-Downtime Column Type Migration for "${table}"."${column}" to ${newType}`,
      phases
    ),
  };
}

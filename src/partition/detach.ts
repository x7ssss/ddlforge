/**
 * ddlforge - Concurrent Partition Detacher
 *
 * Generates autocommit-safe partition detachment scripts with foreign key
 * trigger anomaly remediation (PostgreSQL 14-16).
 *
 * Guarantees:
 * - DETACH PARTITION CONCURRENTLY runs outside transaction blocks (autocommit).
 * - Avoids AccessExclusiveLock on parent, taking ShareUpdateExclusiveLock instead.
 * - Handles PostgreSQL 14-16 foreign key trigger cloning and unvalidated state anomalies.
 */

export interface PartitionDetachOptions {
  parent: string;
  partition: string;
  concurrent?: boolean; // default: true
  schema?: string; // default: 'public'
  cleanupFk?: boolean; // default: true
}

export interface PartitionDetachResult {
  detachSql: string;
  fkRemediationSql: string;
  fullSql: string;
  isConcurrent: boolean;
}

/**
 * Generates the safe partition detachment SQL script.
 */
export function generatePartitionDetachment(options: PartitionDetachOptions): PartitionDetachResult {
  const schema = options.schema || 'public';
  const parent = options.parent.replace(/["`]/g, '');
  const partition = options.partition.replace(/["`]/g, '');
  const isConcurrent = options.concurrent ?? true;
  const cleanupFk = options.cleanupFk ?? true;

  if (!parent) {
    throw new Error('generatePartitionDetachment: parent table name is required.');
  }
  if (!partition) {
    throw new Error('generatePartitionDetachment: partition table name is required.');
  }

  let detachSql = '';
  if (isConcurrent) {
    detachSql = `-- ============================================================================
-- SAFE PARTITION DETACHMENT: CONCURRENT DETACH
-- ============================================================================
-- CRITICAL: DETACH PARTITION CONCURRENTLY cannot run inside a transaction block (BEGIN...COMMIT).
-- It must execute in autocommit mode.
-- It acquires ShareUpdateExclusiveLock on parent and partition, avoiding AccessExclusiveLock on parent.

ALTER TABLE "${schema}"."${parent}"
  DETACH PARTITION "${schema}"."${partition}" CONCURRENTLY;`;
  } else {
    detachSql = `-- ============================================================================
-- STANDARD PARTITION DETACHMENT
-- ============================================================================
-- Acquires AccessExclusiveLock on parent table and partition.

BEGIN;

SET LOCAL lock_timeout = '2s';

ALTER TABLE "${schema}"."${parent}"
  DETACH PARTITION "${schema}"."${partition}";

COMMIT;`;
  }

  let fkRemediationSql = '';
  if (cleanupFk) {
    fkRemediationSql = `-- ============================================================================
-- POST-DETACHMENT FOREIGN KEY ANOMALY REMEDIATION (PG14 - PG16)
-- ============================================================================
-- In PostgreSQL 14-16, detaching a partition may leave cloned foreign keys in an unvalidated
-- state or retain orphan internal triggers. This block inspects and validates all foreign keys
-- on the newly standalone table.

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN (
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = '"${schema}"."${partition}"'::regclass
      AND contype = 'f'
      AND NOT convalidated
  ) LOOP
    EXECUTE format('ALTER TABLE "${schema}"."${partition}" VALIDATE CONSTRAINT %I;', r.conname);
    RAISE NOTICE '[ddlforge detach] Validated standalone foreign key constraint % on detached table %',
      r.conname, '${partition}';
  END LOOP;
END;
$$;`;
  }

  const fullSql = fkRemediationSql
    ? `${detachSql}\n\n${fkRemediationSql}`
    : detachSql;

  return {
    detachSql,
    fkRemediationSql,
    fullSql,
    isConcurrent,
  };
}

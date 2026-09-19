/**
 * ddlforge - Scan-Skipping Partition Attacher
 *
 * Generates the safe 3-phase execution script to attach a partition without
 * table scans or heavy AccessExclusiveLock holding.
 *
 * 3-Phase Scan-Skipping Architecture:
 * 1. Add CHECK constraint matching exact partition bounds with NOT VALID (instantaneous lock).
 * 2. Validate constraint under ShareUpdateExclusiveLock (allows concurrent OLTP reads/writes).
 * 3. Fast ATTACH PARTITION (skips sequential scan because constraint is validated) & drop redundant check.
 */

export interface PartitionAttachOptions {
  parent: string;
  partition: string;
  from: string | number;
  to: string | number;
  key?: string; // default: 'created_at'
  schema?: string; // default: 'public'
  constraintName?: string; // default: `${partition}_bnd_chk`
}

export interface PartitionAttachResult {
  phase1Sql: string; // ADD CONSTRAINT ... NOT VALID
  phase2Sql: string; // VALIDATE CONSTRAINT
  phase3Sql: string; // ATTACH PARTITION & DROP CONSTRAINT
  fullSql: string;
  constraintName: string;
}

/**
 * Formats a boundary literal for SQL generation (quotes strings, leaves numbers bare).
 */
export function formatBoundValue(val: string | number): string {
  if (typeof val === 'number') return String(val);
  const trimmed = String(val).trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    /^-?\d+(\.\d+)?$/.test(trimmed)
  ) {
    return trimmed;
  }
  return `'${trimmed.replace(/'/g, "''")}'`;
}

/**
 * Generates the safe 3-phase partition attachment SQL script.
 */
export function generatePartitionAttachment(options: PartitionAttachOptions): PartitionAttachResult {
  const schema = options.schema || 'public';
  const parent = options.parent.replace(/["`]/g, '');
  const partition = options.partition.replace(/["`]/g, '');
  const key = (options.key || 'created_at').replace(/["`]/g, '');
  const constraintName = (options.constraintName || `${partition}_bnd_chk`).replace(/["`]/g, '');

  if (!parent) {
    throw new Error('generatePartitionAttachment: parent table name is required.');
  }
  if (!partition) {
    throw new Error('generatePartitionAttachment: partition table name is required.');
  }
  if (options.from === undefined || options.from === null || String(options.from).trim() === '') {
    throw new Error('generatePartitionAttachment: lower bound (--from) is required.');
  }
  if (options.to === undefined || options.to === null || String(options.to).trim() === '') {
    throw new Error('generatePartitionAttachment: upper bound (--to) is required.');
  }

  const formattedFrom = formatBoundValue(options.from);
  const formattedTo = formatBoundValue(options.to);

  // Phase 1: ADD CONSTRAINT ... NOT VALID
  const phase1Sql = `-- ============================================================================
-- PHASE 1: ADD BOUNDARY CHECK CONSTRAINT (NOT VALID)
-- ============================================================================
-- Takes a momentary sub-millisecond lock (convalidated = false) without scanning table data.

ALTER TABLE "${schema}"."${partition}"
  ADD CONSTRAINT "${constraintName}"
  CHECK ("${key}" >= ${formattedFrom} AND "${key}" < ${formattedTo}) NOT VALID;`;

  // Phase 2: VALIDATE CONSTRAINT (isolated outside DDL transactions)
  const phase2Sql = `-- ============================================================================
-- PHASE 2: VALIDATE CONSTRAINT (CONCURRENT SHAREUPDATEEXCLUSIVELOCK)
-- ============================================================================
-- CRITICAL: Must be run outside of explicit transaction blocks.
-- Validates rows in child table without blocking concurrent OLTP reads or writes.

ALTER TABLE "${schema}"."${partition}"
  VALIDATE CONSTRAINT "${constraintName}";`;

  // Phase 3: Fast ATTACH PARTITION & DROP redundant CHECK
  const phase3Sql = `-- ============================================================================
-- PHASE 3: SCAN-SKIPPING ATTACH PARTITION & REDUNDANT CHECK CLEANUP
-- ============================================================================
-- PostgreSQL detects convalidated = true and skips the table scan, acquiring
-- AccessExclusiveLock only for an instantaneous metadata update.

BEGIN;

SET LOCAL lock_timeout = '2s';

ALTER TABLE "${schema}"."${parent}"
  ATTACH PARTITION "${schema}"."${partition}"
  FOR VALUES FROM (${formattedFrom}) TO (${formattedTo});

-- Drop redundant CHECK constraint (parent partition bounds now enforce integrity)
ALTER TABLE "${schema}"."${partition}"
  DROP CONSTRAINT "${constraintName}";

COMMIT;`;

  const fullSql = [phase1Sql, phase2Sql, phase3Sql].join('\n\n');

  return {
    phase1Sql,
    phase2Sql,
    phase3Sql,
    fullSql,
    constraintName,
  };
}

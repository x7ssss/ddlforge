/**
 * ddlforge - Online Table Repack SQL Generator
 *
 * Implements battle-tested user-space zero-downtime table compaction:
 * 1. Shadow Table Setup: Creates `<tbl>_repack_shadow` with matching schema, constraints, and indexes.
 * 2. Audit Change-Log Trigger: Captures in-flight DML into `<tbl>_repack_log` with loop guards.
 * 3. Keyset Snapshot Bulk Copy: Keyset-paginated copy with loop commits and jittered sleep throttling.
 * 4. Catch-up Replay Loop: Incrementally catches up logged changes with idempotency guards.
 * 5. Bounded Atomic Swap Protocol: Dedicated transaction with `lock_timeout = '250ms'` and `statement_timeout = '5s'`:
 *    drains remaining delta, validates row count parity, and atomically renames relations.
 */

export interface TableRepackOptions {
  table: string;
  primaryKey?: string; // default: 'id'
  primaryKeyType?: string; // default: 'BIGINT'
  schema?: string; // default: 'public'
  batchSize?: number; // default: 5000
  throttleMs?: number; // default: 20
  shadowTable?: string; // default: `${table}_repack_shadow`
  logTable?: string; // default: `${table}_repack_log`
  archiveTable?: string; // default: `${table}_legacy`
  tablespace?: string;
  fillfactor?: number;
  lockTimeout?: string; // default: '250ms'
  statementTimeout?: string; // default: '5s'
}

export interface TableRepackResult {
  phase1Sql: string; // Shadow table setup
  phase2Sql: string; // Change-log table & trigger
  phase3Sql: string; // Keyset bulk copy procedure
  phase4Sql: string; // Catch-up replay procedure
  phase5Sql: string; // Bounded cutover atomic swap
  fullSql: string;
}

/**
 * Generates the complete 5-phase zero-downtime table repack compaction script.
 */
export function generateTableRepack(options: TableRepackOptions): TableRepackResult {
  const schema = (options.schema || 'public').replace(/["`]/g, '');
  const table = options.table ? options.table.replace(/["`]/g, '') : '';
  const pk = (options.primaryKey || 'id').replace(/["`]/g, '');
  const pkType = options.primaryKeyType || 'BIGINT';
  const batchSize = options.batchSize ?? 5000;
  const throttleMs = options.throttleMs ?? 20;
  const shadowTable = (options.shadowTable || `${table}_repack_shadow`).replace(/["`]/g, '');
  const logTable = (options.logTable || `${table}_repack_log`).replace(/["`]/g, '');
  const archiveTable = (options.archiveTable || `${table}_legacy`).replace(/["`]/g, '');
  const lockTimeout = options.lockTimeout || '250ms';
  const statementTimeout = options.statementTimeout || '5s';

  if (!table) {
    throw new Error('generateTableRepack: table name is required.');
  }

  let tablespaceClause = '';
  if (options.tablespace) {
    tablespaceClause = ` TABLESPACE "${options.tablespace.replace(/["`]/g, '')}"`;
  }

  let withStorageClause = '';
  if (options.fillfactor) {
    withStorageClause = ` WITH (fillfactor = ${options.fillfactor})`;
  }

  // Phase 1: Shadow Table Setup
  const phase1Sql = `-- ============================================================================
-- PHASE 1: SHADOW TABLE SETUP
-- ============================================================================
-- Creates shadow table with matching schema, constraints, defaults, and indexes.

CREATE TABLE "${schema}"."${shadowTable}" (
  LIKE "${schema}"."${table}" INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES
)${withStorageClause}${tablespaceClause};`;

  // Phase 2: Audit Change-Log Trigger & Log Table
  const phase2Sql = `-- ============================================================================
-- PHASE 2: AUDIT CHANGE-LOG TRIGGER & LOG TABLE
-- ============================================================================
-- Captures in-flight DML changes during the bulk copy and catch-up phases.
-- Guarded by pg_trigger_depth() < 2 to prevent cascading loops.

CREATE TABLE IF NOT EXISTS "${schema}"."${logTable}" (
  id BIGSERIAL PRIMARY KEY,
  op VARCHAR(1) NOT NULL, -- 'I'=INSERT, 'U'=UPDATE, 'D'=DELETE
  pk_val ${pkType} NOT NULL,
  payload JSONB,
  logged_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS "idx_${logTable}_id"
  ON "${schema}"."${logTable}" (id);

CREATE OR REPLACE FUNCTION "${schema}"."_ddlforge_repack_log_${table}"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN NULL;
  END IF;

  IF TG_OP = 'INSERT' THEN
    INSERT INTO "${schema}"."${logTable}" (op, pk_val, payload)
    VALUES ('I', NEW."${pk}", to_jsonb(NEW));
  ELSIF TG_OP = 'UPDATE' THEN
    INSERT INTO "${schema}"."${logTable}" (op, pk_val, payload)
    VALUES ('U', NEW."${pk}", to_jsonb(NEW));
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO "${schema}"."${logTable}" (op, pk_val, payload)
    VALUES ('D', OLD."${pk}", NULL);
  END IF;

  RETURN NULL;
END;
$$;

CREATE OR REPLACE TRIGGER "trg_repack_log_${table}"
  AFTER INSERT OR UPDATE OR DELETE ON "${schema}"."${table}"
  FOR EACH ROW
  EXECUTE FUNCTION "${schema}"."_ddlforge_repack_log_${table}"();`;

  // Phase 3: Keyset Snapshot Bulk Copy
  const phase3Sql = `-- ============================================================================
-- PHASE 3: KEYSET SNAPSHOT BULK COPY PROCEDURE
-- ============================================================================
-- Copies historical tuples from "${table}" to "${shadowTable}" in batches
-- using keyset pagination, loop COMMITs, and jittered sleep throttling.

CREATE OR REPLACE PROCEDURE "${schema}"."sp_repack_bulk_copy_${table}"(
  p_batch_size INT DEFAULT ${batchSize},
  p_throttle_ms INT DEFAULT ${throttleMs}
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_last_id ${pkType} := 0;
  v_batch_count INT := 0;
  v_total_rows BIGINT := 0;
  v_throttle_sec NUMERIC := p_throttle_ms / 1000.0;
BEGIN
  RAISE NOTICE '[ddlforge repack] Starting keyset bulk copy from %.% to %.% (batch: %, throttle: %ms)...',
    '${schema}', '${table}', '${schema}', '${shadowTable}', p_batch_size, p_throttle_ms;

  LOOP
    INSERT INTO "${schema}"."${shadowTable}"
    SELECT * FROM "${schema}"."${table}"
    WHERE "${pk}" > v_last_id
    ORDER BY "${pk}" ASC
    LIMIT p_batch_size
    FOR UPDATE SKIP LOCKED
    ON CONFLICT ("${pk}") DO NOTHING;

    GET DIAGNOSTICS v_batch_count = ROW_COUNT;
    EXIT WHEN v_batch_count = 0;

    v_total_rows := v_total_rows + v_batch_count;

    SELECT MAX("${pk}") INTO v_last_id
    FROM (
      SELECT "${pk}"
      FROM "${schema}"."${table}"
      WHERE "${pk}" > v_last_id
      ORDER BY "${pk}" ASC
      LIMIT p_batch_size
    ) sub;

    COMMIT;

    IF v_throttle_sec > 0 THEN
      PERFORM pg_sleep(v_throttle_sec * (0.8 + (random() * 0.4)));
    END IF;

    RAISE NOTICE '[ddlforge repack] Bulk copied % rows (watermark %: %)',
      v_total_rows, '${pk}', v_last_id;
  END LOOP;

  RAISE NOTICE '[ddlforge repack] Bulk copy complete. Total rows copied: %', v_total_rows;
END;
$$;

-- To execute bulk copy:
-- CALL "${schema}"."sp_repack_bulk_copy_${table}"();`;

  // Phase 4: Catch-up Replay Loop
  const phase4Sql = `-- ============================================================================
-- PHASE 4: CATCH-UP REPLAY LOOP PROCEDURE
-- ============================================================================
-- Replays delta changes captured in "${logTable}" into "${shadowTable}".
-- Can be called repeatedly until the lag is within single-batch cutover range.

CREATE OR REPLACE PROCEDURE "${schema}"."sp_repack_replay_log_${table}"(
  p_batch_size INT DEFAULT ${batchSize},
  p_max_iterations INT DEFAULT 1000
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_last_log_id BIGINT := 0;
  v_rec RECORD;
  v_count INT := 0;
  v_iter INT := 0;
BEGIN
  RAISE NOTICE '[ddlforge repack] Starting catch-up replay loop for %.%...', '${schema}', '${table}';

  LOOP
    v_iter := v_iter + 1;
    EXIT WHEN v_iter > p_max_iterations;

    v_count := 0;

    FOR v_rec IN
      SELECT id, op, pk_val, payload
      FROM "${schema}"."${logTable}"
      WHERE id > v_last_log_id
      ORDER BY id ASC
      LIMIT p_batch_size
    LOOP
      v_count := v_count + 1;
      v_last_log_id := v_rec.id;

      IF v_rec.op IN ('I', 'U') THEN
        DELETE FROM "${schema}"."${shadowTable}" WHERE "${pk}" = v_rec.pk_val;
        INSERT INTO "${schema}"."${shadowTable}"
        SELECT * FROM jsonb_populate_record(NULL::"${schema}"."${shadowTable}", v_rec.payload);
      ELSIF v_rec.op = 'D' THEN
        DELETE FROM "${schema}"."${shadowTable}" WHERE "${pk}" = v_rec.pk_val;
      END IF;
    END LOOP;

    COMMIT;
    EXIT WHEN v_count < p_batch_size;
  END LOOP;

  RAISE NOTICE '[ddlforge repack] Catch-up replay iteration complete. Last processed log id: %', v_last_log_id;
END;
$$;

-- To execute catch-up replay:
-- CALL "${schema}"."sp_repack_replay_log_${table}"();`;

  // Phase 5: Bounded Atomic Swap Protocol
  const phase5Sql = `-- ============================================================================
-- PHASE 5: BOUNDED ATOMIC CUTOVER & TEARDOWN
-- ============================================================================
-- Strict bounded transaction: acquires exclusive lock, drains final delta,
-- validates row count parity, drops triggers, and renames shadow to primary.

BEGIN;

SET LOCAL lock_timeout = '${lockTimeout}';
SET LOCAL statement_timeout = '${statementTimeout}';

-- 1. Acquire AccessExclusiveLock on target table to freeze inbound writes
LOCK TABLE "${schema}"."${table}" IN ACCESS EXCLUSIVE MODE;

-- 2. Drain any remaining change log records to achieve 100% sync
DO $$
DECLARE
  v_rec RECORD;
BEGIN
  FOR v_rec IN
    SELECT id, op, pk_val, payload
    FROM "${schema}"."${logTable}"
    ORDER BY id ASC
  LOOP
    IF v_rec.op IN ('I', 'U') THEN
      DELETE FROM "${schema}"."${shadowTable}" WHERE "${pk}" = v_rec.pk_val;
      INSERT INTO "${schema}"."${shadowTable}"
      SELECT * FROM jsonb_populate_record(NULL::"${schema}"."${shadowTable}", v_rec.payload);
    ELSIF v_rec.op = 'D' THEN
      DELETE FROM "${schema}"."${shadowTable}" WHERE "${pk}" = v_rec.pk_val;
    END IF;
  END LOOP;
END;
$$;

-- 3. Validate row count parity before swapping
DO $$
DECLARE
  v_src_count BIGINT;
  v_shadow_count BIGINT;
BEGIN
  SELECT COUNT(*) INTO v_src_count FROM "${schema}"."${table}";
  SELECT COUNT(*) INTO v_shadow_count FROM "${schema}"."${shadowTable}";
  IF v_src_count != v_shadow_count THEN
    RAISE EXCEPTION '[ddlforge repack] Parity check failed: source table has % rows, shadow table has % rows. Aborting cutover.',
      v_src_count, v_shadow_count;
  END IF;
END;
$$;

-- 4. Teardown triggers, functions, log table, and stored procedures
DROP TRIGGER IF EXISTS "trg_repack_log_${table}" ON "${schema}"."${table}";
DROP FUNCTION IF EXISTS "${schema}"."_ddlforge_repack_log_${table}"();
DROP TABLE IF EXISTS "${schema}"."${logTable}";
DROP PROCEDURE IF EXISTS "${schema}"."sp_repack_bulk_copy_${table}";
DROP PROCEDURE IF EXISTS "${schema}"."sp_repack_replay_log_${table}";

-- 5. Sub-millisecond atomic rename swap
ALTER TABLE "${schema}"."${table}" RENAME TO "${archiveTable}";
ALTER TABLE "${schema}"."${shadowTable}" RENAME TO "${table}";

COMMIT;

-- Post-Cutover Optimization & Maintenance:
-- ANALYZE "${schema}"."${table}";
-- DROP TABLE "${schema}"."${archiveTable}";`;

  const fullSql = [phase1Sql, phase2Sql, phase3Sql, phase4Sql, phase5Sql].join('\n\n');

  return {
    phase1Sql,
    phase2Sql,
    phase3Sql,
    phase4Sql,
    phase5Sql,
    fullSql,
  };
}

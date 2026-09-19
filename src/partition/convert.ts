/**
 * ddlforge - Online Monolithic Table Conversion Generator
 *
 * Generates zero-downtime 4-phase migration scripts to convert large monolithic tables
 * into declaratively partitioned tables with zero OLTP disruption.
 *
 * 4-Phase Architecture:
 * 1. Expand: Create shadow partitioned table with matching schema and default partition.
 * 2. Scaffolding: Updatable view abstraction and bidirectional INSTEAD OF / AFTER triggers.
 * 3. Backfill: Keyset-paginated stored procedure with loop commits and jittered sleep.
 * 4. Contract: Sub-millisecond atomic rename swap in an AccessExclusiveLock transaction.
 */

export interface PartitionConvertOptions {
  table: string;
  key: string;
  type?: 'range' | 'list'; // default: 'range'
  primaryKey?: string; // default: 'id'
  primaryKeyType?: string; // default: 'BIGINT'
  batchSize?: number; // default: 5000
  throttleMs?: number; // default: 50
  schema?: string; // default: 'public'
  shadowTable?: string; // default: `${table}_parted`
  archiveTable?: string; // default: `${table}_legacy`
  viewName?: string; // default: `${table}_view`
}

export interface PartitionConvertResult {
  phase1Sql: string; // Shadow table creation
  phase2Sql: string; // Updatable view abstraction & triggers
  phase3Sql: string; // Keyset backfill procedure
  phase4Sql: string; // Cutover atomic swap
  fullSql: string;
}

/**
 * Generates the complete zero-downtime monolithic-to-partitioned conversion SQL script.
 */
export function generatePartitionConversion(options: PartitionConvertOptions): PartitionConvertResult {
  const schema = options.schema || 'public';
  const table = options.table.replace(/["`]/g, '');
  const key = options.key.replace(/["`]/g, '');
  const type = (options.type || 'range').toLowerCase() as 'range' | 'list';
  const pk = (options.primaryKey || 'id').replace(/["`]/g, '');
  const pkType = options.primaryKeyType || 'BIGINT';
  const batchSize = options.batchSize ?? 5000;
  const throttleMs = options.throttleMs ?? 50;
  const shadowTable = (options.shadowTable || `${table}_parted`).replace(/["`]/g, '');
  const archiveTable = (options.archiveTable || `${table}_legacy`).replace(/["`]/g, '');
  const viewName = (options.viewName || `${table}_view`).replace(/["`]/g, '');

  if (!table) {
    throw new Error('generatePartitionConversion: table name is required.');
  }
  if (!key) {
    throw new Error('generatePartitionConversion: partition key is required.');
  }

  // Phase 1: Shadow Table Creation
  const phase1Sql = `-- ============================================================================
-- PHASE 1: SHADOW PARTITIONED TABLE CREATION
-- ============================================================================
-- Creates shadow partitioned table with matching schema and catch-all default partition.
-- NOTE: In PostgreSQL, any UNIQUE or PRIMARY KEY constraint on a partitioned table
-- must include the partition key ("${key}").

CREATE TABLE "${schema}"."${shadowTable}" (
  LIKE "${schema}"."${table}" INCLUDING DEFAULTS INCLUDING CONSTRAINTS
) PARTITION BY ${type.toUpperCase()} ("${key}");

-- Initial catch-all default partition to safely receive out-of-range rows during conversion
CREATE TABLE IF NOT EXISTS "${schema}"."${shadowTable}_default"
  PARTITION OF "${schema}"."${shadowTable}" DEFAULT;`;

  // Phase 2: Scaffolding & Bidirectional Synchronization Triggers
  const phase2Sql = `-- ============================================================================
-- PHASE 2: SCAFFOLDING & BIDIRECTIONAL ROUTING TRIGGERS
-- ============================================================================
-- Replicates writes from "${table}" to "${shadowTable}" during backfill.
-- Includes updatable view abstraction and trigger loop guards (pg_trigger_depth() < 2).

CREATE OR REPLACE FUNCTION "${schema}"."_ddlforge_sync_${table}_to_parted"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    INSERT INTO "${schema}"."${shadowTable}" VALUES (NEW.*)
    ON CONFLICT ("${pk}", "${key}") DO UPDATE
    SET "${key}" = EXCLUDED."${key}";
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    DELETE FROM "${schema}"."${shadowTable}" WHERE "${pk}" = OLD."${pk}";
    INSERT INTO "${schema}"."${shadowTable}" VALUES (NEW.*);
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    DELETE FROM "${schema}"."${shadowTable}" WHERE "${pk}" = OLD."${pk}";
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE TRIGGER "trg_route_to_parted"
  AFTER INSERT OR UPDATE OR DELETE ON "${schema}"."${table}"
  FOR EACH ROW
  EXECUTE FUNCTION "${schema}"."_ddlforge_sync_${table}_to_parted"();

-- Updatable view abstraction for gradual zero-downtime application migration
CREATE OR REPLACE VIEW "${schema}"."${viewName}" AS
  SELECT * FROM "${schema}"."${table}";

CREATE OR REPLACE FUNCTION "${schema}"."_ddlforge_route_view_${table}"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    INSERT INTO "${schema}"."${shadowTable}" VALUES (NEW.*)
    ON CONFLICT ("${pk}", "${key}") DO NOTHING;
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    DELETE FROM "${schema}"."${shadowTable}" WHERE "${pk}" = OLD."${pk}";
    INSERT INTO "${schema}"."${shadowTable}" VALUES (NEW.*);
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    DELETE FROM "${schema}"."${shadowTable}" WHERE "${pk}" = OLD."${pk}";
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE TRIGGER "trg_route_to_legacy"
  INSTEAD OF INSERT OR UPDATE OR DELETE ON "${schema}"."${viewName}"
  FOR EACH ROW
  EXECUTE FUNCTION "${schema}"."_ddlforge_route_view_${table}"();`;

  // Phase 3: Keyset-Paginated Backfill Stored Procedure
  const phase3Sql = `-- ============================================================================
-- PHASE 3: KEYSET-PAGINATED BACKFILL PROCEDURE
-- ============================================================================
-- Migrates historical rows from "${table}" to "${shadowTable}" using crash-safe
-- keyset pagination with loop commits and jittered sleep throttling.

CREATE OR REPLACE PROCEDURE "${schema}"."sp_convert_backfill_${table}"(
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
  RAISE NOTICE '[ddlforge convert] Starting keyset backfill from %.% to %.% (batch_size: %, throttle: %ms)...',
    '${schema}', '${table}', '${schema}', '${shadowTable}', p_batch_size, p_throttle_ms;

  LOOP
    -- Keyset pagination with lock skipping and conflict avoidance
    INSERT INTO "${schema}"."${shadowTable}"
    SELECT * FROM "${schema}"."${table}"
    WHERE "${pk}" > v_last_id
    ORDER BY "${pk}" ASC
    LIMIT p_batch_size
    FOR UPDATE SKIP LOCKED
    ON CONFLICT DO NOTHING;

    GET DIAGNOSTICS v_batch_count = ROW_COUNT;
    EXIT WHEN v_batch_count = 0;

    v_total_rows := v_total_rows + v_batch_count;

    -- Update watermark to highest primary key in the processed batch
    SELECT MAX("${pk}") INTO v_last_id
    FROM (
      SELECT "${pk}"
      FROM "${schema}"."${table}"
      WHERE "${pk}" > v_last_id
      ORDER BY "${pk}" ASC
      LIMIT p_batch_size
    ) sub;

    -- Flush WAL increments and release row locks
    COMMIT;

    -- Jittered sleep throttle to preserve concurrent OLTP query latency
    IF v_throttle_sec > 0 THEN
      PERFORM pg_sleep(v_throttle_sec * (0.8 + (random() * 0.4)));
    END IF;

    RAISE NOTICE '[ddlforge convert] Backfilled % rows (current % watermark: %)',
      v_total_rows, '${pk}', v_last_id;
  END LOOP;

  RAISE NOTICE '[ddlforge convert] Backfill complete. Total rows migrated: %', v_total_rows;
END;
$$;

-- Execute backfill:
-- CALL "${schema}"."sp_convert_backfill_${table}"();`;

  // Phase 4: Atomic Contract & Cutover Swap
  const phase4Sql = `-- ============================================================================
-- PHASE 4: ATOMIC CUTOVER & CONTRACT
-- ============================================================================
-- Drains traffic with strict lock timeout, drops routing triggers, and renames
-- the shadow partitioned table to primary in a sub-millisecond atomic transaction.

BEGIN;

SET LOCAL lock_timeout = '2s';

-- 1. Acquire AccessExclusiveLock on legacy and shadow tables
LOCK TABLE "${schema}"."${table}" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE "${schema}"."${shadowTable}" IN ACCESS EXCLUSIVE MODE;

-- 2. Drop synchronization triggers & views
DROP TRIGGER IF EXISTS "trg_route_to_parted" ON "${schema}"."${table}";
DROP FUNCTION IF EXISTS "${schema}"."_ddlforge_sync_${table}_to_parted"();
DROP TRIGGER IF EXISTS "trg_route_to_legacy" ON "${schema}"."${viewName}";
DROP FUNCTION IF EXISTS "${schema}"."_ddlforge_route_view_${table}"();
DROP VIEW IF EXISTS "${schema}"."${viewName}";

-- 3. Atomic rename swap on pg_class.relname
ALTER TABLE "${schema}"."${table}" RENAME TO "${archiveTable}";
ALTER TABLE "${schema}"."${shadowTable}" RENAME TO "${table}";

COMMIT;

-- 4. Post-Cutover Optimization & Cleanup:
-- ANALYZE "${schema}"."${table}";
-- DROP TABLE "${schema}"."${archiveTable}";`;

  const fullSql = [phase1Sql, phase2Sql, phase3Sql, phase4Sql].join('\n\n');

  return {
    phase1Sql,
    phase2Sql,
    phase3Sql,
    phase4Sql,
    fullSql,
  };
}

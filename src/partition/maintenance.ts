/**
 * ddlforge - Automated Partition Maintenance & Retention Procedure Generator
 *
 * Generates autonomous stored procedures for forward partition pre-allocation (premake)
 * and rolling retention pruning, guarded by bounded lock timeouts to prevent midnight lock storms.
 */

export interface PartitionMaintenanceOptions {
  parent: string;
  interval?: 'monthly' | 'daily'; // default: 'monthly'
  premake?: number; // default: 3
  retention?: number; // default: 12
  schema?: string; // default: 'public'
  key?: string; // default: 'created_at'
  procedureName?: string; // default: `sp_maintain_${parent}_partitions`
  lockTimeout?: string; // default: '2s'
}

export interface PartitionMaintenanceResult {
  procedureName: string;
  procedureSql: string;
  callSql: string;
  fullSql: string;
}

/**
 * Generates an autonomous rolling partition maintenance stored procedure.
 */
export function generatePartitionMaintenance(options: PartitionMaintenanceOptions): PartitionMaintenanceResult {
  const schema = options.schema || 'public';
  const parent = options.parent.replace(/["`]/g, '');
  const interval = (options.interval || 'monthly').toLowerCase() as 'monthly' | 'daily';
  const premake = options.premake ?? 3;
  const retention = options.retention ?? 12;
  const procedureName = (options.procedureName || `sp_maintain_${parent}_partitions`).replace(/["`]/g, '');
  const lockTimeout = options.lockTimeout || '2s';

  if (!parent) {
    throw new Error('generatePartitionMaintenance: parent table name is required.');
  }

  const procedureSql = `-- ============================================================================
-- AUTOMATED ROLLING PARTITION MAINTENANCE PROCEDURE
-- ============================================================================
-- Automatically pre-allocates forward partitions and prunes partitions beyond
-- the retention window under bounded lock_timeout protection.

CREATE OR REPLACE PROCEDURE "${schema}"."${procedureName}"(
  p_schema text DEFAULT '${schema}',
  p_premake int DEFAULT ${premake},
  p_retention int DEFAULT ${retention}
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_i int;
  v_start timestamptz;
  v_end timestamptz;
  v_part_name text;
  v_cutoff timestamptz;
  v_table_exists regclass;
  v_retry int;
  r RECORD;
BEGIN
  -- Bounded lock timeout prevents queuing OLTP transactions during maintenance
  SET LOCAL lock_timeout = '${lockTimeout}';

  RAISE NOTICE '[ddlforge maintenance] Starting rolling partition maintenance for %.% (interval: %, premake: %, retention: %)...',
    p_schema, '${parent}', '${interval}', p_premake, p_retention;

  -- ==========================================================================
  -- 1. PRE-ALLOCATION: Forward partition creation
  -- ==========================================================================
  FOR v_i IN 0..p_premake LOOP
    IF '${interval}' = 'daily' THEN
      v_start := date_trunc('day', CURRENT_TIMESTAMP + (v_i || ' day')::interval);
      v_end := v_start + '1 day'::interval;
      v_part_name := '${parent}_' || to_char(v_start, 'YYYY_MM_DD');
    ELSE
      v_start := date_trunc('month', CURRENT_TIMESTAMP + (v_i || ' month')::interval);
      v_end := v_start + '1 month'::interval;
      v_part_name := '${parent}_' || to_char(v_start, 'YYYY_MM');
    END IF;

    -- Check if child partition already exists in catalog
    SELECT to_regclass(format('%I.%I', p_schema, v_part_name)) INTO v_table_exists;

    IF v_table_exists IS NULL THEN
      v_retry := 0;
      LOOP
        BEGIN
          EXECUTE format(
            'CREATE TABLE IF NOT EXISTS %I.%I PARTITION OF %I.%I FOR VALUES FROM (%L) TO (%L);',
            p_schema, v_part_name, p_schema, '${parent}', v_start, v_end
          );
          RAISE NOTICE '[ddlforge maintenance] Created forward partition %I.%I for [%, %)',
            p_schema, v_part_name, v_start, v_end;
          EXIT;
        EXCEPTION
          WHEN duplicate_table THEN
            RAISE NOTICE '[ddlforge maintenance] Partition %I.%I already created concurrently.', p_schema, v_part_name;
            EXIT;
          WHEN lock_not_available THEN
            v_retry := v_retry + 1;
            IF v_retry > 3 THEN
              RAISE WARNING '[ddlforge maintenance] Lock unavailable creating partition %I.%I after % retries; will retry next schedule.',
                p_schema, v_part_name, v_retry;
              EXIT;
            END IF;
            -- Jittered backoff sleep (0.5s - 1.5s) to avoid midnight lock storms
            PERFORM pg_sleep(0.5 + random() * 1.0);
        END;
      END LOOP;
    END IF;
  END LOOP;

  -- ==========================================================================
  -- 2. RETENTION PRUNING: Safe detachment of expired partitions
  -- ==========================================================================
  IF p_retention > 0 THEN
    IF '${interval}' = 'daily' THEN
      v_cutoff := date_trunc('day', CURRENT_TIMESTAMP - (p_retention || ' day')::interval);
    ELSE
      v_cutoff := date_trunc('month', CURRENT_TIMESTAMP - (p_retention || ' month')::interval);
    END IF;

    FOR r IN (
      SELECT
        c.relname AS partition_name,
        n.nspname AS partition_schema
      FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
      JOIN pg_class p ON p.oid = i.inhparent
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_namespace pn ON pn.oid = p.relnamespace
      WHERE p.relname = '${parent}'
        AND pn.nspname = p_schema
        AND c.relispartition = true
        AND (
          CASE
            WHEN '${interval}' = 'daily' AND c.relname ~ ('^' || '${parent}' || '_[0-9]{4}_[0-9]{2}_[0-9]{2}$') THEN
              to_timestamp(substring(c.relname from '${parent}_([0-9]{4}_[0-9]{2}_[0-9]{2})$'), 'YYYY_MM_DD') < v_cutoff
            WHEN '${interval}' = 'monthly' AND c.relname ~ ('^' || '${parent}' || '_[0-9]{4}_[0-9]{2}$') THEN
              to_timestamp(substring(c.relname from '${parent}_([0-9]{4}_[0-9]{2})$'), 'YYYY_MM') < v_cutoff
            ELSE false
          END
        )
    ) LOOP
      -- Attempt safe detachment protected by lock_timeout with jittered retry
      v_retry := 0;
      LOOP
        BEGIN
          EXECUTE format(
            'ALTER TABLE %I.%I DETACH PARTITION %I.%I;',
            p_schema, '${parent}', r.partition_schema, r.partition_name
          );
          RAISE NOTICE '[ddlforge maintenance] Detached expired partition %I.%I (cutoff: %)',
            r.partition_schema, r.partition_name, v_cutoff;
          EXIT;
        EXCEPTION
          WHEN lock_not_available THEN
            v_retry := v_retry + 1;
            IF v_retry > 3 THEN
              RAISE WARNING '[ddlforge maintenance] Lock timeout detaching %I.%I after % retries; skipping for next run.',
                r.partition_schema, r.partition_name, v_retry;
              EXIT;
            END IF;
            PERFORM pg_sleep(0.5 + random() * 1.0);
        END;
      END LOOP;
    END LOOP;
  END IF;

  RAISE NOTICE '[ddlforge maintenance] Partition maintenance finished successfully for %.%', p_schema, '${parent}';
END;
$$;`;

  const callSql = `CALL "${schema}"."${procedureName}"();`;
  const fullSql = `${procedureSql}\n\n-- Run maintenance now:\n${callSql}`;

  return {
    procedureName,
    procedureSql,
    callSql,
    fullSql,
  };
}

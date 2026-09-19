/**
 * ddlforge - Resumable Keyset Backfill Generator
 *
 * Generates autonomous PL/pgSQL stored procedures for zero-downtime data backfilling.
 *
 * Key guarantees:
 * - Uses keyset pagination (WHERE id > v_last_id ORDER BY id ASC LIMIT batch_size FOR UPDATE SKIP LOCKED)
 *   over CTID to ensure deterministic, crash-safe progress surviving autovacuum tuple relocation.
 * - Emits periodic COMMIT statements to release row locks and truncate WAL increments.
 * - Throttles backfills with jittered sleep: PERFORM pg_sleep(0.05 + random() * 0.05);.
 * - Enforces SET LOCAL lock_timeout = '2s' with exponential backoff on lock_not_available.
 */

export interface BackfillOptions {
  table: string;
  fromColumn: string;
  toColumn: string;
  primaryKey?: string;
  primaryKeyType?: string;
  batchSize?: number;
  schema?: string;
  transformExpression?: string;
  procedureName?: string;
}

export interface BackfillResult {
  procedureName: string;
  procedureSql: string;
  callSql: string;
  fullSql: string;
}

/**
 * Generates a zero-downtime resumable keyset backfill stored procedure.
 */
export function generateBackfillProcedure(options: BackfillOptions): BackfillResult {
  const schema = options.schema || 'public';
  const table = options.table.replace(/["`]/g, '');
  const fromCol = options.fromColumn.replace(/["`]/g, '');
  const toCol = options.toColumn.replace(/["`]/g, '');
  const pk = (options.primaryKey || 'id').replace(/["`]/g, '');
  const pkType = options.primaryKeyType || 'BIGINT';
  const batchSize = options.batchSize || 5000;
  const transform = options.transformExpression || `"${fromCol}"`;
  const procedureName = options.procedureName || `sp_backfill_${table}_${toCol}`;

  const procedureSql = `CREATE OR REPLACE PROCEDURE "${schema}"."${procedureName}"(
  p_batch_size INT DEFAULT ${batchSize}
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_last_id ${pkType} := NULL;
  v_rows_updated INT := 0;
  v_total_updated BIGINT := 0;
  v_batch_ids ${pkType}[];
  v_retry_count INT;
  v_success BOOLEAN;
  v_backoff NUMERIC;
BEGIN
  LOOP
    v_success := FALSE;
    v_retry_count := 0;
    v_backoff := 0.1;

    -- Exponential backoff loop protecting against lock acquisition timeouts
    WHILE NOT v_success AND v_retry_count <= 5 LOOP
      BEGIN
        EXECUTE 'SET LOCAL lock_timeout = ''2s''';

        -- Keyset pagination: lock the next candidate batch with FOR UPDATE SKIP LOCKED
        IF v_last_id IS NULL THEN
          SELECT array_agg("${pk}")
          INTO v_batch_ids
          FROM (
            SELECT "${pk}"
            FROM "${schema}"."${table}"
            WHERE "${toCol}" IS DISTINCT FROM (${transform})
            ORDER BY "${pk}" ASC
            LIMIT p_batch_size
            FOR UPDATE SKIP LOCKED
          ) sub;
        ELSE
          SELECT array_agg("${pk}")
          INTO v_batch_ids
          FROM (
            SELECT "${pk}"
            FROM "${schema}"."${table}"
            WHERE "${pk}" > v_last_id
              AND ("${toCol}" IS DISTINCT FROM (${transform}))
            ORDER BY "${pk}" ASC
            LIMIT p_batch_size
            FOR UPDATE SKIP LOCKED
          ) sub;
        END IF;

        IF v_batch_ids IS NULL OR array_length(v_batch_ids, 1) IS NULL THEN
          v_rows_updated := 0;
          v_success := TRUE;
          EXIT;
        END IF;

        -- Update the locked candidate batch
        UPDATE "${schema}"."${table}"
        SET "${toCol}" = ${transform}
        WHERE "${pk}" = ANY(v_batch_ids);

        GET DIAGNOSTICS v_rows_updated = ROW_COUNT;
        v_total_updated := v_total_updated + v_rows_updated;

        -- Advance keyset watermark
        v_last_id := v_batch_ids[array_length(v_batch_ids, 1)];
        v_success := TRUE;

      EXCEPTION WHEN lock_not_available THEN
        v_retry_count := v_retry_count + 1;
        IF v_retry_count > 5 THEN
          RAISE EXCEPTION 'Backfill on %.% aborted after % retries due to lock contention',
            '${schema}.${table}', '${toCol}', v_retry_count;
        END IF;
        -- Jittered exponential backoff
        PERFORM pg_sleep(v_backoff + random() * 0.05);
        v_backoff := v_backoff * 2;
      END;
    END LOOP;

    -- Exit loop when no more candidate rows remain
    EXIT WHEN v_rows_updated = 0;

    -- Release row locks and truncate WAL increments
    COMMIT;

    -- Jittered throttle sleep to prevent starve out of concurrent application queries
    PERFORM pg_sleep(0.05 + random() * 0.05);
  END LOOP;

  RAISE NOTICE 'Backfill finished for %.% -> %.%: % rows updated.',
    '${schema}.${table}', '${fromCol}', '${schema}.${table}', '${toCol}', v_total_updated;
END;
$$;`;

  const callSql = `CALL "${schema}"."${procedureName}"();`;

  const fullSql = [
    `-- ══════════════════════════════════════════════════════════════════════`,
    `-- Resumable Keyset Backfill Procedure: ${table}.${fromCol} -> ${table}.${toCol}`,
    `-- Primary key: ${pk} (${pkType})`,
    `-- ══════════════════════════════════════════════════════════════════════`,
    procedureSql,
    '',
    `-- ── Invocation ───────────────────────────────────────────────────────`,
    callSql,
  ].join('\n');

  return {
    procedureName,
    procedureSql,
    callSql,
    fullSql,
  };
}

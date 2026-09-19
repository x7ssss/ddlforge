/**
 * ddlforge - Keyset Backfill Masking Generator
 *
 * Generates autonomous PL/pgSQL stored procedures for zero-downtime historical
 * PII data anonymization using crash-safe keyset pagination.
 *
 * Guarantees:
 * - Keyset pagination (WHERE id > v_last_id ORDER BY id ASC LIMIT batch_size FOR UPDATE SKIP LOCKED).
 * - Per-batch transaction COMMITs to truncate WAL accumulation and release row locks.
 * - Exponential backoff retry loop with bounded SET LOCAL lock_timeout = '2s'.
 * - Cyclic relationship support via SET CONSTRAINTS ALL DEFERRED.
 * - Jittered sleep throttling to protect concurrent OLTP queries.
 */

import { parseColumnMaskConfigs, ColumnMaskConfig, generateMaskingHelpers } from './triggers.js';

export interface MaskingBackfillOptions {
  table: string;
  columns: (string | ColumnMaskConfig)[];
  primaryKey?: string;
  primaryKeyType?: string; // default: 'BIGINT'
  batchSize?: number; // default: 2500
  schema?: string;
  procedureName?: string;
  deferConstraints?: boolean; // default: true
  saltGuc?: string; // default: 'app.masking_salt'
  includeHelpers?: boolean; // default: false (usually installed by triggers)
}

export interface MaskingBackfillResult {
  procedureName: string;
  procedureSql: string;
  callSql: string;
  fullSql: string;
  columns: ColumnMaskConfig[];
}

/**
 * Generates a zero-downtime resumable keyset backfill stored procedure for PII masking.
 */
export function generateMaskingBackfill(options: MaskingBackfillOptions): MaskingBackfillResult {
  const schema = options.schema || 'public';
  const table = options.table.replace(/["`]/g, '');
  const pk = (options.primaryKey || 'id').replace(/["`]/g, '');
  const pkType = options.primaryKeyType || 'BIGINT';
  const batchSize = options.batchSize || 2500;
  const procedureName = options.procedureName || `sp_mask_backfill_${table}`;
  const deferConstraints = options.deferConstraints ?? true;
  const saltGuc = options.saltGuc || 'app.masking_salt';
  const includeHelpers = options.includeHelpers ?? false;

  const columns = parseColumnMaskConfigs(options.columns);
  if (columns.length === 0) {
    throw new Error(`generateMaskingBackfill: At least one column must be specified for table "${table}".`);
  }

  // Generate UPDATE set expressions and filter conditions
  const updateClauses: string[] = [];
  const distinctClauses: string[] = [];

  for (const col of columns) {
    const src = col.sourceColumn;
    const tgt = col.targetColumn!;
    const domain = col.domainTag || src;

    let expr = '';
    switch (col.maskType) {
      case 'email':
        expr = `_ddlforge_mask_email("${src}", '${domain}')`;
        break;
      case 'integer':
        expr = `feistel_encrypt_integer("${src}")`;
        break;
      case 'uuid':
        expr = `_ddlforge_mask_uuid("${src}", '${domain}')`;
        break;
      case 'custom':
        expr = col.customExpression || `_ddlforge_hmac_token("${src}"::text, '${domain}')`;
        break;
      case 'text':
      default:
        expr = `_ddlforge_hmac_token("${src}", '${domain}')`;
        break;
    }

    updateClauses.push(`          "${tgt}" = ${expr}`);
    distinctClauses.push(`"${tgt}" IS DISTINCT FROM ${expr}`);
  }

  const whereDistinctCombined = distinctClauses.length > 1
    ? `(${distinctClauses.join(' OR ')})`
    : distinctClauses[0];

  const deferConstraintsSql = deferConstraints
    ? `\n        -- Defer foreign key constraints to support cyclic references\n        SET CONSTRAINTS ALL DEFERRED;`
    : '';

  const helperSql = includeHelpers ? generateMaskingHelpers(saltGuc) + '\n\n' : '';

  const procedureSql = `CREATE OR REPLACE PROCEDURE "${schema}"."${procedureName}"(
  p_batch_size INT DEFAULT ${batchSize}
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
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
  -- Verify salt presence
  IF current_setting('${saltGuc}', true) IS NULL OR current_setting('${saltGuc}', true) = '' THEN
    RAISE NOTICE 'ddlforge backfill: Variable % is empty. Using default fallback salt.', '${saltGuc}';
  END IF;

  LOOP
    v_success := FALSE;
    v_retry_count := 0;
    v_backoff := 0.1;

    -- Exponential backoff loop protecting against lock acquisition timeouts
    WHILE NOT v_success AND v_retry_count <= 5 LOOP
      BEGIN
        EXECUTE 'SET LOCAL lock_timeout = ''2s''';${deferConstraintsSql}

        -- Keyset pagination: lock the next candidate batch with FOR UPDATE SKIP LOCKED
        IF v_last_id IS NULL THEN
          SELECT array_agg("${pk}")
          INTO v_batch_ids
          FROM (
            SELECT "${pk}"
            FROM "${schema}"."${table}"
            WHERE ${whereDistinctCombined}
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
              AND ${whereDistinctCombined}
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

        -- Update the locked candidate batch with deterministic masked values
        UPDATE "${schema}"."${table}"
        SET
${updateClauses.join(',\n')}
        WHERE "${pk}" = ANY(v_batch_ids);

        GET DIAGNOSTICS v_rows_updated = ROW_COUNT;
        v_total_updated := v_total_updated + v_rows_updated;

        -- Advance keyset watermark to highest primary key in batch
        v_last_id := v_batch_ids[array_length(v_batch_ids, 1)];
        v_success := TRUE;

      EXCEPTION WHEN lock_not_available THEN
        v_retry_count := v_retry_count + 1;
        IF v_retry_count > 5 THEN
          RAISE EXCEPTION 'Masking backfill on %.% aborted after % retries due to lock contention',
            '${schema}', '${table}', v_retry_count;
        END IF;
        -- Jittered exponential backoff
        PERFORM pg_sleep(v_backoff + random() * 0.05);
        v_backoff := v_backoff * 2;
      END;
    END LOOP;

    -- Exit loop when no more candidate rows remain
    EXIT WHEN v_rows_updated = 0;

    -- Commit transaction to release row locks and flush WAL increments
    COMMIT;

    -- Jittered throttle sleep to prevent starve out of concurrent application queries
    PERFORM pg_sleep(0.05 + random() * 0.05);
  END LOOP;

  RAISE NOTICE 'Masking backfill completed for %.%: % rows sanitized.',
    '${schema}', '${table}', v_total_updated;
END;
$$;`;

  const callSql = `CALL "${schema}"."${procedureName}"(${batchSize});`;

  const fullSql = [
    `-- ══════════════════════════════════════════════════════════════════════`,
    `-- ddlforge Keyset Masking Backfill Procedure: ${table}`,
    `-- Columns: ${columns.map(c => `${c.sourceColumn} -> ${c.targetColumn}`).join(', ')}`,
    `-- Primary key: ${pk} (${pkType}) | Batch size: ${batchSize}`,
    `-- ══════════════════════════════════════════════════════════════════════`,
    helperSql,
    procedureSql,
    '',
    `-- ── Invocation ───────────────────────────────────────────────────────`,
    callSql,
  ].filter(Boolean).join('\n');

  return {
    procedureName,
    procedureSql,
    callSql,
    fullSql,
    columns,
  };
}

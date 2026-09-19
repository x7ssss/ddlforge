/**
 * ddlforge - Dual-Write Trigger Generator
 *
 * Generates zero-downtime PL/pgSQL BEFORE INSERT OR UPDATE triggers on physical tables.
 *
 * Key guarantees:
 * - Operates entirely in memory on NEW records without issuing secondary UPDATE statements.
 * - Uses IS DISTINCT FROM for null-safe mutation detection.
 * - Enforces WHEN (pg_trigger_depth() < 2) to terminate recursive trigger chains without session_replication_role.
 */

export interface DualWriteTriggerOptions {
  table: string;
  sourceColumn: string;
  targetColumn: string;
  schema?: string;
  forwardTransform?: string; // expression calculating targetColumn from sourceColumn
  reverseTransform?: string; // expression calculating sourceColumn from targetColumn
  bidirectional?: boolean; // default true
}

export interface DualWriteTriggerResult {
  triggerName: string;
  functionName: string;
  functionSql: string;
  triggerSql: string;
  fullSql: string;
  teardownSql: string;
}

/**
 * Generates a non-blocking dual-write PL/pgSQL trigger and function.
 */
export function generateDualWriteTrigger(options: DualWriteTriggerOptions): DualWriteTriggerResult {
  const schema = options.schema || 'public';
  const table = options.table.replace(/["`]/g, '');
  const source = options.sourceColumn.replace(/["`]/g, '');
  const target = options.targetColumn.replace(/["`]/g, '');
  const bidirectional = options.bidirectional ?? true;

  const fwdExpr = options.forwardTransform || `NEW."${source}"`;
  const revExpr = options.reverseTransform || `NEW."${target}"`;

  const functionName = `tf_sync_${table}_${source}_${target}`;
  const triggerName = `trg_sync_${table}_${source}_${target}`;

  let syncLogic = '';

  if (bidirectional) {
    syncLogic = `  -- Bidirectional synchronization operating in-memory on NEW record
  IF TG_OP = 'INSERT' THEN
    -- On INSERT: synchronize whichever column was supplied
    IF NEW."${source}" IS NOT NULL AND NEW."${target}" IS NULL THEN
      NEW."${target}" := ${fwdExpr};
    ELSIF NEW."${target}" IS NOT NULL AND NEW."${source}" IS NULL THEN
      NEW."${source}" := ${revExpr};
    ELSIF NEW."${source}" IS DISTINCT FROM NEW."${target}" THEN
      NEW."${target}" := ${fwdExpr};
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    -- On UPDATE: detect which column changed using IS DISTINCT FROM
    IF NEW."${source}" IS DISTINCT FROM OLD."${source}" THEN
      IF (NEW."${target}" IS NOT DISTINCT FROM OLD."${target}") OR (NEW."${target}" IS DISTINCT FROM NEW."${source}") THEN
        NEW."${target}" := ${fwdExpr};
      END IF;
    ELSIF NEW."${target}" IS DISTINCT FROM OLD."${target}" THEN
      IF (NEW."${source}" IS NOT DISTINCT FROM OLD."${source}") OR (NEW."${source}" IS DISTINCT FROM NEW."${target}") THEN
        NEW."${source}" := ${revExpr};
      END IF;
    END IF;
  END IF;`;
  } else {
    syncLogic = `  -- Unidirectional forward synchronization (source -> target)
  IF TG_OP = 'INSERT' THEN
    NEW."${target}" := ${fwdExpr};
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW."${source}" IS DISTINCT FROM OLD."${source}" THEN
      NEW."${target}" := ${fwdExpr};
    END IF;
  END IF;`;
  }

  const functionSql = `CREATE OR REPLACE FUNCTION "${schema}"."${functionName}"()
RETURNS TRIGGER AS $$
BEGIN
${syncLogic}
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;`;

  const triggerSql = `CREATE OR REPLACE TRIGGER "${triggerName}"
BEFORE INSERT OR UPDATE ON "${schema}"."${table}"
FOR EACH ROW
WHEN (pg_trigger_depth() < 2)
EXECUTE FUNCTION "${schema}"."${functionName}"();`;

  const teardownSql = `DROP TRIGGER IF EXISTS "${triggerName}" ON "${schema}"."${table}";
DROP FUNCTION IF EXISTS "${schema}"."${functionName}"();`;

  const fullSql = [
    `-- ── Dual-Write Synchronization Trigger for ${table}.${source} <-> ${table}.${target} ──`,
    functionSql,
    '',
    triggerSql,
  ].join('\n');

  return {
    triggerName,
    functionName,
    functionSql,
    triggerSql,
    fullSql,
    teardownSql,
  };
}

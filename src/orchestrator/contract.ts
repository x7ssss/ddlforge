/**
 * ddlforge - Contract Phase Teardown Generator
 *
 * Emits GitLab 3-release teardown migrations for zero-downtime column and view deprecation.
 *
 * Key guarantees:
 * - Drops triggers and functions under 2s lock_timeout.
 * - Drops legacy virtual view and schema.
 * - Relaxes constraints on legacy columns (ALTER COLUMN ... DROP NOT NULL).
 * - Executes physical column drop under transaction-level advisory locks (pg_advisory_xact_lock) with retry backoff.
 * - Warns against PgBouncer prepared statement cache invalidations ("cached plan must not change result type").
 */

export interface ContractOptions {
  table: string;
  column: string;
  schema?: string; // legacy schema, default 'public_v1'
  physicalSchema?: string; // default 'public'
  triggerName?: string;
  functionName?: string;
  lockTimeout?: string; // default '2s'
  maxRetries?: number; // default 5
}

export interface ContractPhase {
  phase: number;
  title: string;
  description: string;
  sql: string;
}

export interface ContractResult {
  scriptSql: string;
  phases: ContractPhase[];
  warnings: string[];
}

/**
 * Generates the complete 3-release contraction phase teardown script.
 */
export function generateContractScript(options: ContractOptions): ContractResult {
  const table = options.table.replace(/["`]/g, '');
  const column = options.column.replace(/["`]/g, '');
  const legacySchema = (options.schema || 'public_v1').replace(/["`]/g, '');
  const physicalSchema = (options.physicalSchema || 'public').replace(/["`]/g, '');
  const lockTimeout = options.lockTimeout || '2s';
  const maxRetries = options.maxRetries || 5;

  const triggerName = options.triggerName || `trg_sync_${table}_${column}`;
  const functionName = options.functionName || `tf_sync_${table}_${column}`;

  const warnings: string[] = [
    `WARNING: Dropping column "${column}" on "${table}" can invalidate prepared statements cached by connection poolers (PgBouncer in transaction mode).`,
    `Prepared statements with 'SELECT *' will encounter: ERROR: cached plan must not change result type (SQLSTATE 0A000).`,
    `Ensure application services do not reference column "${column}", select explicit column projections, and restart or reload poolers after teardown.`,
  ];

  const phases: ContractPhase[] = [
    {
      phase: 1,
      title: `Release N+1: Relax constraints on legacy column "${column}"`,
      description: 'Allows legacy column to accept NULL values so new application writes no longer require it.',
      sql: `BEGIN;
SET LOCAL lock_timeout = '${lockTimeout}';
ALTER TABLE "${physicalSchema}"."${table}" ALTER COLUMN "${column}" DROP NOT NULL;
COMMIT;`,
    },
    {
      phase: 2,
      title: `Release N+2: Drop dual-write triggers and functions`,
      description: 'Terminates synchronization between legacy and new columns after application has switched.',
      sql: `BEGIN;
SET LOCAL lock_timeout = '${lockTimeout}';
DROP TRIGGER IF EXISTS "${triggerName}" ON "${physicalSchema}"."${table}";
DROP FUNCTION IF EXISTS "${physicalSchema}"."${functionName}"();
COMMIT;`,
    },
    {
      phase: 3,
      title: `Release N+2: Drop legacy view and virtual schema "${legacySchema}"`,
      description: 'Removes legacy virtual views and cleans up deprecated schema.',
      sql: `BEGIN;
SET LOCAL lock_timeout = '${lockTimeout}';
DROP VIEW IF EXISTS "${legacySchema}"."${table}";
DROP SCHEMA IF EXISTS "${legacySchema}" CASCADE;
COMMIT;`,
    },
    {
      phase: 4,
      title: `Release N+2: Drop physical column "${column}" under advisory lock with retry`,
      description: 'Safely acquires table-level advisory lock with backoff and drops the physical column.',
      sql: `DO $$
DECLARE
  v_locked BOOLEAN := FALSE;
  v_retries INT := 0;
  v_backoff NUMERIC := 0.1;
BEGIN
  LOOP
    BEGIN
      EXECUTE 'SET LOCAL lock_timeout = ''${lockTimeout}''';

      -- Transaction-level advisory lock coordinates table DDL safely
      PERFORM pg_advisory_xact_lock(hashtext('${physicalSchema}.${table}')::bigint);
      v_locked := TRUE;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      v_retries := v_retries + 1;
      IF v_retries > ${maxRetries} THEN
        RAISE EXCEPTION 'Could not acquire advisory lock on %.% after % attempts',
          '${physicalSchema}', '${table}', v_retries;
      END IF;
      PERFORM pg_sleep(v_backoff + random() * 0.05);
      v_backoff := v_backoff * 2;
    END;
  END LOOP;

  EXECUTE 'ALTER TABLE "${physicalSchema}"."${table}" DROP COLUMN IF EXISTS "${column}"';
  RAISE NOTICE 'Column %.%.% dropped successfully under advisory lock.',
    '${physicalSchema}', '${table}', '${column}';
END $$;`,
    },
  ];

  const headerChunks: string[] = [
    `-- ══════════════════════════════════════════════════════════════════════`,
    `-- Zero-Downtime Contraction Script: ${physicalSchema}.${table}.${column}`,
    `-- Legacy Schema: ${legacySchema}`,
    `-- Pattern: GitLab 3-Release Teardown`,
    `-- ══════════════════════════════════════════════════════════════════════`,
    '',
  ];

  for (const w of warnings) {
    headerChunks.push(`-- ${w}`);
  }
  headerChunks.push('');

  for (const p of phases) {
    headerChunks.push(`-- ── Phase ${p.phase}: ${p.title} ──`);
    headerChunks.push(`-- ${p.description}`);
    headerChunks.push(p.sql);
    headerChunks.push('');
  }

  return {
    scriptSql: headerChunks.join('\n'),
    phases,
    warnings,
  };
}

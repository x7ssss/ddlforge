/**
 * ddlforge - PostgreSQL DDL execution supervisor.
 *
 * Responsibilities
 * ────────────────
 * 1. Dynamically imports `pg` at runtime (graceful error if not installed).
 * 2. Parses SQL migration files into individual statements (reuses the existing
 *    zero-dependency lexer — no duplicate parser code).
 * 3. For each statement:
 *    a. Opens a transaction on a fresh client.
 *    b. Injects `SET LOCAL lock_timeout` and `SET LOCAL statement_timeout`.
 *    c. Executes the statement.
 *    d. On error 55P03 (lock_not_available) or 57014 (query_canceled):
 *       – Rolls back, waits for a full-jitter backoff interval, retries.
 *    e. On avalanche detected by the lock monitor: rolls back and aborts.
 *    f. On success: commits and proceeds to the next statement.
 * 4. Reports live progress via an optional EventEmitter-compatible callback.
 *
 * Zero-dependency invariant
 * ─────────────────────────
 * `pg` is imported with `await import('pg')` inside an async function so it
 * never appears in the static import graph.  Static linting (`ddlforge check`)
 * works without `pg` installed.
 */

import { splitStatements } from '../lexer/sqlTokenizer.js';
import { sleep, computeBackoff } from './backoff.js';
import { startLockMonitor, isLockError, MonitorClient } from './locksMonitor.js';

/* ------------------------------------------------------------------ */
/* Public types                                                          */
/* ------------------------------------------------------------------ */

export interface ExecutorOptions {
  /** Full PostgreSQL connection string or URL */
  databaseUrl: string;
  /** lock_timeout value (e.g. "2500ms" or "2500"). Default: "3000ms" */
  lockTimeout?: string;
  /** statement_timeout value (e.g. "30000ms"). Default: "30000ms" */
  statementTimeout?: string;
  /** Maximum number of retry attempts per statement on lock errors. Default: 5 */
  maxRetries?: number;
  /** If true, parse and validate statements but never execute them. Default: false */
  dryRun?: boolean;
  /**
   * Number of blocked backends that triggers an avalanche abort.
   * Default: 1 (abort as soon as even one query queues behind ours).
   */
  lockQueueThreshold?: number;
  /** Milliseconds between lock-monitor polls. Default: 500 */
  monitorPollMs?: number;
  /** Progress callback invoked after each statement attempt */
  onProgress?: (event: ExecutionEvent) => void;
  /** AbortSignal for external cancellation */
  signal?: AbortSignal;
}

export type ExecutionEventKind =
  | 'statement-start'
  | 'statement-success'
  | 'statement-retry'
  | 'statement-failed'
  | 'avalanche-abort'
  | 'dry-run-statement'
  | 'migration-complete'
  | 'migration-failed';

export interface ExecutionEvent {
  kind: ExecutionEventKind;
  statementIndex: number;
  totalStatements: number;
  statementSql: string;
  attempt: number;
  elapsedMs: number;
  error?: string;
  lockTimeoutMs?: number;
  retryBackoffMs?: number;
}

export interface ExecutionResult {
  success: boolean;
  statementsExecuted: number;
  statementsTotal: number;
  durationMs: number;
  error?: string;
  avalanche?: boolean;
}

/* ------------------------------------------------------------------ */
/* pg dynamic import helper                                             */
/* ------------------------------------------------------------------ */

interface PgModule {
  default: {
    Pool: new (opts: { connectionString: string; max: number }) => PgPool;
    Client: new (opts: { connectionString: string }) => PgClient;
  };
}

interface PgPool {
  connect(): Promise<PgClient>;
  end(): Promise<void>;
}

interface PgClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  release?(): void;
  end(): Promise<void>;
}

/**
 * Dynamically imports pg and returns the Pool and Client constructors.
 * If pg is not installed, prints clear installation instructions and throws.
 */
async function loadPg(): Promise<PgModule['default']> {
  try {
    // Dynamic import: NOT in static import graph — ddlforge check still works
    const mod = await import('pg') as PgModule;
    return mod.default;
  } catch {
    const msg = [
      '',
      '  ╔══════════════════════════════════════════════════════════╗',
      '  ║  ddlforge apply requires the "pg" package to be         ║',
      '  ║  installed in your project.                             ║',
      '  ║                                                          ║',
      '  ║  Run one of:                                             ║',
      '  ║    npm install pg                                        ║',
      '  ║    yarn add pg                                           ║',
      '  ║    pnpm add pg                                           ║',
      '  ╚══════════════════════════════════════════════════════════╝',
      '',
    ].join('\n');
    process.stderr.write(msg + '\n');
    throw new Error('pg package is not installed. Run: npm install pg');
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

/**
 * Normalises a timeout value into a bare integer millisecond string
 * suitable for `SET LOCAL lock_timeout = '<value>'`.
 *
 * Accepts:
 *  - "3000ms"  → "3000"
 *  - "3s"      → "3000"  (NOT handled — pass pre-converted ms values)
 *  - "3000"    → "3000"
 *  - 3000      → "3000"
 */
function normaliseTimeoutMs(value: string | number): string {
  const s = String(value).trim();
  if (s.endsWith('ms')) {
    return s.slice(0, -2);
  }
  return s;
}

/**
 * Returns the `code` from a Postgres-driver error object.
 * pg errors expose `.code` as a top-level property.
 */
function pgErrorCode(err: unknown): string {
  if (err !== null && typeof err === 'object' && 'code' in err) {
    return String((err as Record<string, unknown>)['code'] ?? '');
  }
  return '';
}

/* ------------------------------------------------------------------ */
/* Statement text reconstruction                                        */
/* ------------------------------------------------------------------ */

/**
 * Extracts the original SQL text for a statement from the migration file.
 * We reconstruct it from the token raw values so that whitespace is
 * preserved reasonably well for display purposes.
 */
function statementText(raw: string): string {
  // The lexer joins tokens with single spaces; we just use the raw field.
  return raw.trimEnd() + ';';
}

/* ------------------------------------------------------------------ */
/* Main executor                                                        */
/* ------------------------------------------------------------------ */

/**
 * Executes a SQL migration file against a PostgreSQL database with:
 *  - per-statement lock-timeout injection
 *  - exponential full-jitter retry on lock acquisition failures
 *  - background lock-queue monitoring with automatic cancellation
 *
 * @param sql     Full text of the migration file
 * @param options Execution configuration
 */
export async function executeMigration(
  sql: string,
  options: ExecutorOptions,
): Promise<ExecutionResult> {
  const {
    databaseUrl,
    lockTimeout        = '3000ms',
    statementTimeout   = '30000ms',
    maxRetries         = 5,
    dryRun             = false,
    lockQueueThreshold = 1,
    monitorPollMs      = 500,
    onProgress,
    signal,
  } = options;

  const lockTimeoutMs    = normaliseTimeoutMs(lockTimeout);
  const statementTimeoutMs = normaliseTimeoutMs(statementTimeout);

  const migrationStart = Date.now();

  // ── Parse statements (zero-dependency lexer) ────────────────────────
  const statements = splitStatements(sql);
  const total      = statements.length;

  if (total === 0) {
    return { success: true, statementsExecuted: 0, statementsTotal: 0, durationMs: 0 };
  }

  // ── Dry run mode ─────────────────────────────────────────────────────
  if (dryRun) {
    for (let i = 0; i < statements.length; i++) {
      const stmt = statements[i];
      onProgress?.({
        kind:            'dry-run-statement',
        statementIndex:  i,
        totalStatements: total,
        statementSql:    statementText(stmt.raw),
        attempt:         0,
        elapsedMs:       Date.now() - migrationStart,
      });
    }
    return {
      success:            true,
      statementsExecuted: 0,
      statementsTotal:    total,
      durationMs:         Date.now() - migrationStart,
    };
  }

  // ── Load pg ──────────────────────────────────────────────────────────
  const { Pool, Client } = await loadPg();

  // One pool for the migration; monitor gets its own direct clients
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });

  let statementsExecuted = 0;
  let globalError: string | undefined;
  let avalanche = false;

  try {
    for (let i = 0; i < statements.length; i++) {
      if (signal?.aborted) {
        globalError = 'Execution aborted by caller signal.';
        break;
      }

      const stmt        = statements[i];
      const stmtSql     = statementText(stmt.raw);
      const stmtStart   = Date.now();
      let   succeeded   = false;
      let   stmtError: string | undefined;

      onProgress?.({
        kind:            'statement-start',
        statementIndex:  i,
        totalStatements: total,
        statementSql:    stmtSql,
        attempt:         0,
        elapsedMs:       stmtStart - migrationStart,
        lockTimeoutMs:   Number(lockTimeoutMs),
      });

      // ── Retry loop per statement ──────────────────────────────────────
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (signal?.aborted) break;

        // Jitter-sleep before all retries (not before first attempt)
        if (attempt > 0) {
          const backoff = computeBackoff(attempt - 1, {
            baseDelayMs: 250,
            maxDelayMs:  10_000,
            maxRetries,
          });

          onProgress?.({
            kind:             'statement-retry',
            statementIndex:   i,
            totalStatements:  total,
            statementSql:     stmtSql,
            attempt,
            elapsedMs:        Date.now() - migrationStart,
            retryBackoffMs:   backoff.sleepMs,
          });

          await sleep(backoff.sleepMs, signal);
          if (signal?.aborted) break;
        }

        // Grab a client from the pool for this attempt
        const client  = await pool.connect() as unknown as PgClient;

        // Snapshot our backend PID for the lock monitor
        let migrationPid = -1;
        try {
          const pidResult = await client.query('SELECT pg_backend_pid() AS pid');
          migrationPid = Number(pidResult.rows[0]?.['pid'] ?? -1);
        } catch {
          // Fallback: proceed without monitoring
        }

        // Start the lock monitor on its own independent connection
        const monitorClientFactory = async (): Promise<MonitorClient> => {
          const monClient = new Client({ connectionString: databaseUrl });
          await (monClient as unknown as { connect(): Promise<void> }).connect?.();
          return monClient as unknown as MonitorClient;
        };

        const monitor = migrationPid > 0
          ? startLockMonitor({
              migrationPid,
              clientFactory:  monitorClientFactory,
              pollIntervalMs: monitorPollMs,
              queueThreshold: lockQueueThreshold,
              signal,
            })
          : null;

        try {
          // Open transaction
          await client.query('BEGIN');

          // Inject session-local timeouts (scoped to this transaction)
          await client.query(`SET LOCAL lock_timeout = '${lockTimeoutMs}'`);
          await client.query(`SET LOCAL statement_timeout = '${statementTimeoutMs}'`);

          // Execute the DDL statement
          await client.query(stmtSql);

          // Commit
          await client.query('COMMIT');

          // Stop monitor — execution succeeded, no avalanche
          monitor?.stop();
          const monResult = await monitor?.result;
          if (monResult?.avalanche) {
            // Race condition: monitor fired just as we committed.
            // The COMMIT succeeded so we treat this as a success.
            // (pg_cancel_backend after COMMIT is a no-op.)
          }

          succeeded = true;
          stmtError = undefined;
          break; // exit retry loop

        } catch (err: unknown) {
          const code = pgErrorCode(err);

          // Stop monitor before doing anything else
          monitor?.stop();
          const monResult = await monitor?.result;

          // Rollback the failed transaction
          try { await client.query('ROLLBACK'); } catch { /* ignore */ }

          if (monResult?.avalanche) {
            // Lock-queue avalanche: abort the entire migration
            onProgress?.({
              kind:            'avalanche-abort',
              statementIndex:  i,
              totalStatements: total,
              statementSql:    stmtSql,
              attempt,
              elapsedMs:       Date.now() - migrationStart,
              error:           `Lock-queue avalanche: ${monResult.blockedCount} backend(s) queued. Cancelled at ${monResult.cancelledAt}.`,
            });
            globalError = `Lock-queue avalanche detected. ${monResult.blockedCount} backend(s) were waiting behind migration PID ${migrationPid}. Migration aborted to protect connection pool.`;
            avalanche   = true;
            break;
          }

          if (isLockError(code) && attempt < maxRetries) {
            // Retryable lock error — continue retry loop
            stmtError = `[${code}] ${(err as Error).message ?? String(err)}`;
            continue;
          }

          // Non-retryable error or max retries exhausted
          stmtError = `[${code || 'ERR'}] ${(err as Error).message ?? String(err)}`;
          break;

        } finally {
          client.release?.();
        }
      } // end retry loop

      if (avalanche) break;

      if (signal?.aborted && !succeeded) {
        globalError = 'Execution aborted by caller signal.';
        break;
      }

      if (succeeded) {
        statementsExecuted++;
        onProgress?.({
          kind:            'statement-success',
          statementIndex:  i,
          totalStatements: total,
          statementSql:    stmtSql,
          attempt:         0,
          elapsedMs:       Date.now() - stmtStart,
        });
      } else {
        globalError = stmtError ?? 'Unknown execution error.';
        onProgress?.({
          kind:            'statement-failed',
          statementIndex:  i,
          totalStatements: total,
          statementSql:    stmtSql,
          attempt:         maxRetries,
          elapsedMs:       Date.now() - stmtStart,
          error:           globalError,
        });
        break;
      }
    }
  } finally {
    await pool.end().catch(() => { /* ignore cleanup errors */ });
  }

  const durationMs  = Date.now() - migrationStart;
  const success     = !globalError;

  onProgress?.({
    kind:            success ? 'migration-complete' : 'migration-failed',
    statementIndex:  statementsExecuted,
    totalStatements: total,
    statementSql:    '',
    attempt:         0,
    elapsedMs:       durationMs,
    error:           globalError,
  });

  return {
    success,
    statementsExecuted,
    statementsTotal: total,
    durationMs,
    error:     globalError,
    avalanche: avalanche || undefined,
  };
}

/**
 * Parses a SQL migration string and returns the list of individual statements
 * that would be executed. Useful for tooling and dry-run previews.
 */
export function parseMigrationStatements(sql: string): string[] {
  return splitStatements(sql).map(s => statementText(s.raw));
}

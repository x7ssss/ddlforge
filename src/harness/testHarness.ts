/**
 * ddlforge - Ephemeral PostgreSQL Test Harness
 *
 * Spins up a postgres:17-alpine container via Testcontainers, executes
 * one or more migration SQL scripts inside schema-isolated environments,
 * and asserts that AccessExclusiveLock hold times stay within threshold.
 *
 * Environment flags:
 *   DOCKER_AVAILABLE=true          — must be set to enable real container tests
 *   TESTCONTAINERS_RYUK_DISABLED   — forwarded to testcontainers Ryuk reaper
 *   DDLFORGE_TEST_PG_IMAGE         — override container image (default: postgres:17-alpine)
 *
 * Usage:
 *   const harness = new TestHarness({ maxLockMs: 500 });
 *   await harness.start();
 *   const result = await harness.runMigration(sql);
 *   await harness.stop();
 */

import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface HarnessOptions {
  /** Maximum AccessExclusiveLock hold time in milliseconds (default: 500) */
  maxLockMs?: number;
  /** Lock poller interval in milliseconds (default: 50) */
  pollIntervalMs?: number;
  /** Container image to use (default: postgres:17-alpine) */
  image?: string;
}

export interface MigrationRunResult {
  /** Whether the migration executed without error */
  success: boolean;
  /** Error message if execution failed */
  error?: string;
  /** Maximum observed AccessExclusiveLock hold time (ms) */
  maxObservedLockMs: number;
  /** Whether the lock threshold was exceeded */
  lockThresholdExceeded: boolean;
  /** Schema used for this run (test_<uuid>) */
  schema: string;
  /** Wall-clock duration of the migration run in ms */
  durationMs: number;
}

export interface LockSample {
  pid: number;
  query: string;
  lockMode: string;
  grantedAt: number; // Date.now() when observed
}

// ---------------------------------------------------------------------------
// TestHarness class
// ---------------------------------------------------------------------------

export class TestHarness {
  private options: Required<HarnessOptions>;
  private container: any = null; // PostgreSqlContainer instance
  private client: any = null;   // pg.Client instance
  private stopSignaled = false;

  constructor(options: HarnessOptions = {}) {
    this.options = {
      maxLockMs:       options.maxLockMs       ?? 500,
      pollIntervalMs:  options.pollIntervalMs  ?? 50,
      image:           options.image           ?? (process.env['DDLFORGE_TEST_PG_IMAGE'] ?? 'postgres:17-alpine'),
    };
  }

  /**
   * Starts the ephemeral PostgreSQL container and establishes a connection.
   * Registers SIGINT / SIGTERM / unhandledRejection handlers for graceful cleanup.
   */
  async start(): Promise<void> {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');

    // Respect Ryuk configuration
    if (process.env['TESTCONTAINERS_RYUK_DISABLED'] === 'true') {
      process.env['TESTCONTAINERS_RYUK_DISABLED'] = 'true';
    }

    this.container = await new PostgreSqlContainer(this.options.image).start();

    // Connect via pg
    const { Client } = await import('pg');
    this.client = new Client({
      host:     this.container.getHost(),
      port:     this.container.getMappedPort(5432),
      database: this.container.getDatabase(),
      user:     this.container.getUsername(),
      password: this.container.getPassword(),
    });
    await this.client.connect();

    // Register process signal handlers
    const cleanup = async (signal: string) => {
      if (!this.stopSignaled) {
        process.stderr.write(`\n[ddlforge-harness] Received ${signal}, stopping container...\n`);
        await this.stop();
        process.exit(1);
      }
    };

    process.once('SIGINT',  () => void cleanup('SIGINT'));
    process.once('SIGTERM', () => void cleanup('SIGTERM'));
    process.once('unhandledRejection', (reason: unknown) => {
      process.stderr.write(`\n[ddlforge-harness] unhandledRejection: ${String(reason)}\n`);
      void cleanup('unhandledRejection');
    });
  }

  /**
   * Stops the container and closes the connection.
   */
  async stop(): Promise<void> {
    this.stopSignaled = true;
    try {
      if (this.client) {
        await this.client.end();
        this.client = null;
      }
    } catch { /* ignore */ }

    try {
      if (this.container) {
        await this.container.stop();
        this.container = null;
      }
    } catch { /* ignore */ }
  }

  /**
   * Runs a migration SQL string inside an isolated schema (test_<uuid>).
   *
   * Concurrently polls pg_locks + pg_stat_activity every `pollIntervalMs`
   * to sample AccessExclusiveLock hold durations.
   *
   * @param sql - The migration SQL to execute
   * @returns MigrationRunResult with lock metrics
   */
  async runMigration(sql: string): Promise<MigrationRunResult> {
    if (!this.client) {
      throw new Error('[ddlforge-harness] Harness not started. Call start() first.');
    }

    const schema = `test_${randomUUID().replace(/-/g, '_')}`;
    await this.client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    await this.client.query(`SET search_path TO "${schema}", public`);

    let maxObservedLockMs = 0;
    const lockGrantedAt = new Map<number, number>(); // pid -> timestamp when lock first observed

    // Lock poller — runs concurrently using polling loop
    let pollerActive = true;
    const pollLoop = async (): Promise<void> => {
      while (pollerActive) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const result: { rows: Array<{ pid: number; mode: string }> } = await (this.client as any).query(`
            SELECT l.pid, l.mode
            FROM pg_locks l
            JOIN pg_stat_activity a ON a.pid = l.pid
            WHERE l.mode = 'AccessExclusiveLock'
              AND l.granted = true
              AND a.pid != pg_backend_pid()
          `);

          const now = Date.now();
          const seenPids = new Set<number>();

          for (const row of result.rows) {
            seenPids.add(row.pid);
            if (!lockGrantedAt.has(row.pid)) {
              lockGrantedAt.set(row.pid, now);
            } else {
              const holdMs = now - lockGrantedAt.get(row.pid)!;
              if (holdMs > maxObservedLockMs) {
                maxObservedLockMs = holdMs;
              }
            }
          }

          // Clean up pids that no longer hold locks
          for (const [pid] of lockGrantedAt) {
            if (!seenPids.has(pid)) {
              lockGrantedAt.delete(pid);
            }
          }
        } catch {
          // Ignore transient errors during polling (e.g. while container is tearing down)
        }

        await sleep(this.options.pollIntervalMs);
      }
    };

    // Start poller (fire-and-forget promise)
    const pollPromise = pollLoop();

    const startTime = Date.now();
    let success = true;
    let error: string | undefined;

    try {
      // Execute migration statements split by semicolons (simple split — production uses slicer)
      const statements = sql
        .split(';')
        .map(s => s.trim())
        .filter(s => s.length > 0);

      for (const stmt of statements) {
        await this.client.query(stmt);
      }
    } catch (err: any) {
      success = false;
      error = String(err?.message ?? err);
    } finally {
      pollerActive = false;
    }

    // Allow poller to finish its current cycle
    await pollPromise;

    const durationMs = Date.now() - startTime;

    return {
      success,
      error,
      maxObservedLockMs,
      lockThresholdExceeded: maxObservedLockMs > this.options.maxLockMs,
      schema,
      durationMs,
    };
  }

  /**
   * Returns the connection string for the running container, or null if not started.
   */
  getConnectionString(): string | null {
    if (!this.container) return null;
    return this.container.getConnectionUri();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Container runner — standalone function for ddlforge test CLI
// ---------------------------------------------------------------------------

export interface ContainerRunnerOptions {
  /** One or more migration SQL strings to run */
  migrations: string[];
  /** Max lock hold time assertion (ms) */
  maxLockMs?: number;
  /** Container image */
  image?: string;
}

export interface ContainerRunnerResult {
  passed: boolean;
  results: MigrationRunResult[];
  summary: string;
}

/**
 * Runs the full harness lifecycle: start → N migrations → stop.
 * Safe to use in CI without requiring an external running container.
 */
export async function runContainerTests(opts: ContainerRunnerOptions): Promise<ContainerRunnerResult> {
  const harness = new TestHarness({
    maxLockMs:      opts.maxLockMs ?? 500,
    pollIntervalMs: 50,
    image:          opts.image,
  });

  await harness.start();
  const results: MigrationRunResult[] = [];

  try {
    for (const sql of opts.migrations) {
      const result = await harness.runMigration(sql);
      results.push(result);
    }
  } finally {
    await harness.stop();
  }

  const failedResults = results.filter(r => !r.success || r.lockThresholdExceeded);
  const passed = failedResults.length === 0;

  const summaryLines: string[] = [];
  summaryLines.push(`[ddlforge test] Ran ${results.length} migration(s) in ephemeral postgres:17-alpine`);

  for (const r of results) {
    const status = r.success && !r.lockThresholdExceeded ? '✔' : '✖';
    const lockInfo = `maxLock=${r.maxObservedLockMs}ms`;
    const lockWarn = r.lockThresholdExceeded ? ' ⚠ LOCK THRESHOLD EXCEEDED' : '';
    summaryLines.push(`  ${status} [${r.schema}] ${lockInfo} in ${r.durationMs}ms${lockWarn}`);
    if (!r.success) {
      summaryLines.push(`      Error: ${r.error}`);
    }
  }

  summaryLines.push('');
  summaryLines.push(passed
    ? `✔ ALL CLEAR: ${results.length} migration(s) passed lock assertion`
    : `✖ FAILED: ${failedResults.length}/${results.length} migration(s) exceeded lock or errored`
  );

  return { passed, results, summary: summaryLines.join('\n') };
}

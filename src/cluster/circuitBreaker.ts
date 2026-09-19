/**
 * ddlforge - Autonomous Lock Pre-emption & DDL Circuit Breaker
 *
 * Implements dual-connection real-time lock pre-emption and decorrelated jitter
 * retry loops (GitLab / Shopify SLRU blueprint) to prevent head-of-line lock convoys.
 */

import { EventEmitter } from 'node:events';
import type { PgClientLike } from './advisory.js';

export interface CircuitBreakerOptions {
  /** Maximum number of queued/blocked queries allowed before tripping (default: 5) */
  maxQueueDepth?: number;
  /** Maximum milliseconds a blocked query may wait before tripping (default: 200 ms) */
  maxQueueWaitMs?: number;
  /** Polling interval for the sniffer connection (default: 50 ms) */
  pollIntervalMs?: number;
}

export interface CircuitBreakerRetryOptions {
  /** Maximum number of retries before aborting (default: 50) */
  maxRetries?: number;
  /** Initial base delay in milliseconds (default: 100 ms) */
  baseDelayMs?: number;
  /** Maximum delay cap in milliseconds (default: 5000 ms) */
  capDelayMs?: number;
}

export interface CircuitBreakerPool {
  connect(): Promise<PgClientLike & { release?: () => void; end?: () => Promise<void> }>;
}

export interface CircuitBreakerRunResult {
  success: boolean;
  attempts: number;
  totalDurationMs: number;
  error?: Error;
}

/**
 * Calculates backoff sleep duration using Decorrelated Jitter:
 *   sleepMs = Math.min(capMs, Math.floor(Math.random() * (prevSleep * 3 - baseMs + 1)) + baseMs)
 *
 * Guarantees:
 * - Output is strictly between baseMs and capMs.
 * - Prevents lock convoys and thundering herds across connection poolers (PgBouncer).
 */
export function calculateDecorrelatedJitter(
  baseMs: number,
  capMs: number,
  prevSleepMs: number
): number {
  const base = Math.max(1, Math.floor(baseMs));
  const cap = Math.max(base, Math.floor(capMs));
  const prev = Math.max(base, Math.floor(prevSleepMs));

  const maxRange = Math.max(1, prev * 3 - base + 1);
  const jittered = Math.floor(Math.random() * maxRange) + base;

  return Math.min(cap, Math.max(base, jittered));
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Checks whether an error represents a retryable lock timeout or circuit-breaker cancellation.
 */
export function isRetryableLockError(err: any): boolean {
  if (!err) return false;
  const code = err.code || err.sqlState;
  // 55P03: lock_not_available
  // 57014: query_canceled (issued by pg_cancel_backend from sniffer)
  if (code === '55P03' || code === '57014') return true;

  const msg = String(err.message || '').toLowerCase();
  return (
    msg.includes('lock_not_available') ||
    msg.includes('query_canceled') ||
    msg.includes('canceling statement due to user request') ||
    msg.includes('statement canceled') ||
    msg.includes('lock timeout')
  );
}

/**
 * Autonomous Circuit Breaker executing DDL queries on an Executor connection
 * while a separate Sniffer connection monitors blocked OLTP traffic and trips
 * pre-emptive cancellation on head-of-line lock buildup.
 */
export class MigrationCircuitBreaker extends EventEmitter {
  public readonly maxQueueDepth: number;
  public readonly maxQueueWaitMs: number;
  public readonly pollIntervalMs: number;

  constructor(options: CircuitBreakerOptions = {}) {
    super();
    this.maxQueueDepth = options.maxQueueDepth ?? 5;
    this.maxQueueWaitMs = options.maxQueueWaitMs ?? 200;
    this.pollIntervalMs = options.pollIntervalMs ?? 50;
  }

  /**
   * Executes DDL with autonomous lock pre-emption and decorrelated jitter retries.
   */
  async executeWithPreemption(
    pool: CircuitBreakerPool,
    ddlSql: string,
    retryOptions: CircuitBreakerRetryOptions = {}
  ): Promise<CircuitBreakerRunResult> {
    const maxRetries = retryOptions.maxRetries ?? 50;
    const baseDelayMs = retryOptions.baseDelayMs ?? 100;
    const capDelayMs = retryOptions.capDelayMs ?? 5000;

    let attempt = 0;
    let prevSleepMs = baseDelayMs;
    const startTime = Date.now();

    while (attempt <= maxRetries) {
      attempt++;

      // Connect executor and sniffer clients
      const executor = await pool.connect();
      const sniffer = await pool.connect();

      let executorPid = 0;
      let snifferActive = true;
      let snifferTimer: NodeJS.Timeout | null = null;

      try {
        // Retrieve backend PID of executor connection
        const pidRes = await executor.query('SELECT pg_backend_pid() AS pid');
        executorPid = Number(pidRes.rows[0]?.['pid'] || 0);

        // Start sniffer background polling loop
        const snifferLoop = async () => {
          if (!snifferActive || !executorPid) return;
          try {
            const checkQuery = `
              SELECT
                COUNT(*) AS queue_depth,
                COALESCE(MAX(EXTRACT(EPOCH FROM (clock_timestamp() - act.query_start)) * 1000), 0) AS max_wait_ms
              FROM pg_stat_activity act
              WHERE $1 = ANY(pg_blocking_pids(act.pid))
                AND act.state = 'active'
                AND act.pid != $1;
            `;
            const res = await sniffer.query(checkQuery, [executorPid]);
            const queueDepth = Number(res.rows[0]?.['queue_depth'] || 0);
            const maxWaitMs = Number(res.rows[0]?.['max_wait_ms'] || 0);

            if (queueDepth > this.maxQueueDepth || maxWaitMs > this.maxQueueWaitMs) {
              // Trip circuit breaker: cancel executor to yield to OLTP queries
              await sniffer.query('SELECT pg_cancel_backend($1)', [executorPid]).catch(() => {});
              this.emit('tripped', {
                executorPid,
                queueDepth,
                maxWaitMs,
                attempt,
              });
              snifferActive = false;
              return;
            }
          } catch {
            // Sniffer query errors do not fail the migration
          }

          if (snifferActive) {
            snifferTimer = setTimeout(snifferLoop, this.pollIntervalMs);
          }
        };

        // Launch sniffer loop
        snifferTimer = setTimeout(snifferLoop, this.pollIntervalMs);

        // Execute DDL statement on executor connection
        await executor.query(ddlSql);

        // Success! Stop sniffer
        snifferActive = false;
        if (snifferTimer) clearTimeout(snifferTimer);

        const totalDurationMs = Date.now() - startTime;
        this.emit('success', { durationMs: totalDurationMs, attempts: attempt });

        return {
          success: true,
          attempts: attempt,
          totalDurationMs,
        };
      } catch (err: any) {
        snifferActive = false;
        if (snifferTimer) clearTimeout(snifferTimer);

        if (isRetryableLockError(err) && attempt <= maxRetries) {
          const sleepMs = calculateDecorrelatedJitter(baseDelayMs, capDelayMs, prevSleepMs);
          prevSleepMs = sleepMs;

          this.emit('retry', {
            attempt,
            sleepMs,
            error: err,
          });

          await sleep(sleepMs);
          continue;
        }

        // Fatal non-retryable error or max retries exceeded
        const totalDurationMs = Date.now() - startTime;
        this.emit('aborted', { attempts: attempt, error: err });

        return {
          success: false,
          attempts: attempt,
          totalDurationMs,
          error: err instanceof Error ? err : new Error(String(err)),
        };
      } finally {
        snifferActive = false;
        if (snifferTimer) clearTimeout(snifferTimer);

        if (executor.release) executor.release();
        else if (executor.end) await executor.end().catch(() => {});

        if (sniffer.release) sniffer.release();
        else if (sniffer.end) await sniffer.end().catch(() => {});
      }
    }

    const finalErr = new Error(`MigrationCircuitBreaker: Exceeded max retries (${maxRetries}).`);
    this.emit('aborted', { attempts: attempt, error: finalErr });
    return {
      success: false,
      attempts: attempt,
      totalDurationMs: Date.now() - startTime,
      error: finalErr,
    };
  }
}

/**
 * ddlforge - High-Throughput Multi-Tenant Worker Pool
 *
 * Provides bounded asynchronous worker queue execution with:
 * - Configurable concurrency limit (default: 8)
 * - Per-operation rate limiting & pacing
 * - Strict failure isolation so individual tenant errors do not corrupt or abort the fleet
 * - Precise execution timing and summary statistics
 */

import type { TenantTarget } from './tenantRouter.js';

export interface WorkerPoolOptions {
  concurrency?: number; // Default: 8
  rateLimitPerSec?: number; // Optional rate limit: max operations initiated per second
  throttleMs?: number; // Optional explicit delay between starting tasks
  stopOnError?: boolean; // Default: false (failure isolation)
  onProgress?: (progress: WorkerPoolProgress) => void;
}

export interface WorkerPoolProgress {
  completed: number;
  total: number;
  target: TenantTarget;
  status: 'SUCCESS' | 'FAILED' | 'SKIPPED';
  durationMs: number;
  error?: string;
}

export interface TenantExecutionResult {
  tenantId: string;
  tenantName: string;
  strategy: string;
  status: 'SUCCESS' | 'FAILED' | 'SKIPPED';
  durationMs: number;
  error?: string;
  details?: any;
}

export interface BatchExecutionSummary {
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  durationMs: number;
  results: TenantExecutionResult[];
}

/**
 * Asynchronously executes a function across an array of tenant targets with bounded concurrency,
 * rate limiting, and failure isolation.
 */
export async function executeWorkerPool<T = any>(
  targets: TenantTarget[],
  taskFn: (target: TenantTarget) => Promise<T>,
  options: WorkerPoolOptions = {}
): Promise<BatchExecutionSummary> {
  const concurrency = Math.max(1, options.concurrency ?? 8);
  const throttleMs = options.throttleMs ?? (options.rateLimitPerSec && options.rateLimitPerSec > 0
    ? Math.ceil(1000 / options.rateLimitPerSec)
    : 0);
  const stopOnError = options.stopOnError ?? false;

  const total = targets.length;
  const results: TenantExecutionResult[] = new Array(total);
  const startTime = Date.now();

  if (total === 0) {
    return {
      total: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
      durationMs: 0,
      results: [],
    };
  }

  let nextIndex = 0;
  let completedCount = 0;
  let hasAborted = false;

  async function worker(): Promise<void> {
    while (nextIndex < total && !hasAborted) {
      const currentIndex = nextIndex++;
      const target = targets[currentIndex];

      if (hasAborted) {
        results[currentIndex] = {
          tenantId: target.id,
          tenantName: target.name,
          strategy: target.strategy,
          status: 'SKIPPED',
          durationMs: 0,
        };
        completedCount++;
        continue;
      }

      if (throttleMs > 0 && currentIndex > 0) {
        await new Promise(resolve => setTimeout(resolve, throttleMs));
      }

      const taskStart = Date.now();
      try {
        const details = await taskFn(target);
        const durationMs = Date.now() - taskStart;

        results[currentIndex] = {
          tenantId: target.id,
          tenantName: target.name,
          strategy: target.strategy,
          status: 'SUCCESS',
          durationMs,
          details,
        };

        if (options.onProgress) {
          options.onProgress({
            completed: ++completedCount,
            total,
            target,
            status: 'SUCCESS',
            durationMs,
          });
        }
      } catch (err: any) {
        const durationMs = Date.now() - taskStart;
        const errorMessage = err?.message ?? String(err);

        results[currentIndex] = {
          tenantId: target.id,
          tenantName: target.name,
          strategy: target.strategy,
          status: 'FAILED',
          durationMs,
          error: errorMessage,
        };

        if (stopOnError) {
          hasAborted = true;
        }

        if (options.onProgress) {
          options.onProgress({
            completed: ++completedCount,
            total,
            target,
            status: 'FAILED',
            durationMs,
            error: errorMessage,
          });
        }
      }
    }
  }

  // Launch initial worker pool
  const workerPromises: Promise<void>[] = [];
  const workerCount = Math.min(concurrency, total);
  for (let i = 0; i < workerCount; i++) {
    workerPromises.push(worker());
  }

  await Promise.all(workerPromises);

  // Fill in any remaining skipped slots if aborted
  for (let i = 0; i < total; i++) {
    if (!results[i]) {
      results[i] = {
        tenantId: targets[i].id,
        tenantName: targets[i].name,
        strategy: targets[i].strategy,
        status: 'SKIPPED',
        durationMs: 0,
      };
    }
  }

  const succeeded = results.filter(r => r.status === 'SUCCESS').length;
  const failed = results.filter(r => r.status === 'FAILED').length;
  const skipped = results.filter(r => r.status === 'SKIPPED').length;

  return {
    total,
    succeeded,
    failed,
    skipped,
    durationMs: Date.now() - startTime,
    results,
  };
}

/**
 * Formats worker pool execution summary into a readable terminal table.
 */
export function formatExecutionSummaryTerminal(summary: BatchExecutionSummary): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('  ddlforge v1.8.0 — Multi-Tenant Migration Execution Summary');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push(`Total Targets:     ${summary.total}`);
  lines.push(`Succeeded:         ${summary.succeeded}`);
  lines.push(`Failed:            ${summary.failed}`);
  lines.push(`Skipped:           ${summary.skipped}`);
  lines.push(`Total Duration:    ${summary.durationMs}ms`);
  lines.push('');

  lines.push('TARGET                           STRATEGY   STATUS     DURATION    INFO');
  lines.push('─────────────────────────────────────────────────────────────────────────');

  for (const r of summary.results) {
    const nameCol = r.tenantName.padEnd(32).slice(0, 32);
    const stratCol = r.strategy.padEnd(10).slice(0, 10);
    const statusCol = r.status.padEnd(10).slice(0, 10);
    const durCol = `${r.durationMs}ms`.padEnd(11).slice(0, 11);
    const info = r.error ? `ERROR: ${r.error}` : 'OK';
    lines.push(`${nameCol} ${stratCol} ${statusCol} ${durCol} ${info}`);
  }

  lines.push('');
  return lines.join('\n');
}

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  executeWorkerPool,
  formatExecutionSummaryTerminal,
} from '../../src/distributed/workerPool.js';
import type { TenantTarget } from '../../src/distributed/tenantRouter.js';

describe('High-Throughput Multi-Tenant Worker Pool (src/distributed/workerPool.ts)', () => {
  const createTargets = (count: number): TenantTarget[] => {
    return Array.from({ length: count }, (_, idx) => ({
      id: `tenant_${idx + 1}`,
      name: `Tenant ${idx + 1}`,
      strategy: 'schema',
      schema: `tenant_${idx + 1}`,
    }));
  };

  it('handles empty target list gracefully', async () => {
    const summary = await executeWorkerPool([], async () => 'ok');
    assert.strictEqual(summary.total, 0);
    assert.strictEqual(summary.succeeded, 0);
    assert.strictEqual(summary.failed, 0);
    assert.strictEqual(summary.skipped, 0);
    assert.deepStrictEqual(summary.results, []);
  });

  it('executes tasks respecting concurrency limits', async () => {
    const targets = createTargets(10);
    let activeWorkers = 0;
    let maxObservedConcurrency = 0;

    const summary = await executeWorkerPool(
      targets,
      async (target) => {
        activeWorkers++;
        if (activeWorkers > maxObservedConcurrency) {
          maxObservedConcurrency = activeWorkers;
        }
        await new Promise(r => setTimeout(r, 20));
        activeWorkers--;
        return { target: target.id };
      },
      { concurrency: 3 }
    );

    assert.strictEqual(summary.total, 10);
    assert.strictEqual(summary.succeeded, 10);
    assert.strictEqual(summary.failed, 0);
    assert.ok(maxObservedConcurrency <= 3);
  });

  it('isolates failures so single-tenant error does not fail the fleet', async () => {
    const targets = createTargets(5);

    const summary = await executeWorkerPool(
      targets,
      async (target) => {
        if (target.id === 'tenant_3') {
          throw new Error('Lock timeout on tenant_3');
        }
        return 'success';
      },
      { concurrency: 2, stopOnError: false }
    );

    assert.strictEqual(summary.total, 5);
    assert.strictEqual(summary.succeeded, 4);
    assert.strictEqual(summary.failed, 1);
    assert.strictEqual(summary.skipped, 0);

    const failed = summary.results.find(r => r.tenantId === 'tenant_3');
    assert.ok(failed);
    assert.strictEqual(failed.status, 'FAILED');
    assert.ok(failed.error?.includes('Lock timeout on tenant_3'));

    const succeeded = summary.results.filter(r => r.status === 'SUCCESS');
    assert.strictEqual(succeeded.length, 4);
  });

  it('halts and skips remaining tasks when stopOnError is true', async () => {
    const targets = createTargets(6);

    const summary = await executeWorkerPool(
      targets,
      async (target) => {
        if (target.id === 'tenant_1') {
          throw new Error('Critical migration failure on tenant_1');
        }
        return 'ok';
      },
      { concurrency: 1, stopOnError: true }
    );

    assert.strictEqual(summary.total, 6);
    assert.strictEqual(summary.failed, 1);
    assert.ok(summary.skipped > 0);
    assert.strictEqual(summary.succeeded + summary.failed + summary.skipped, 6);
  });

  it('invokes onProgress callback during task execution', async () => {
    const targets = createTargets(4);
    const progressUpdates: number[] = [];

    await executeWorkerPool(
      targets,
      async () => 'done',
      {
        concurrency: 2,
        onProgress: (p) => {
          progressUpdates.push(p.completed);
        },
      }
    );

    assert.strictEqual(progressUpdates.length, 4);
    assert.deepStrictEqual(progressUpdates.sort(), [1, 2, 3, 4]);
  });

  it('formats execution summary report for terminal display', () => {
    const mockSummary = {
      total: 3,
      succeeded: 2,
      failed: 1,
      skipped: 0,
      durationMs: 120,
      results: [
        {
          tenantId: 'tenant_1',
          tenantName: 'Tenant 1',
          strategy: 'schema',
          status: 'SUCCESS' as const,
          durationMs: 40,
        },
        {
          tenantId: 'tenant_2',
          tenantName: 'Tenant 2',
          strategy: 'schema',
          status: 'FAILED' as const,
          durationMs: 50,
          error: 'Relation "orders" does not exist',
        },
        {
          tenantId: 'tenant_3',
          tenantName: 'Tenant 3',
          strategy: 'schema',
          status: 'SUCCESS' as const,
          durationMs: 30,
        },
      ],
    };

    const output = formatExecutionSummaryTerminal(mockSummary);
    assert.ok(output.includes('Multi-Tenant Migration Execution Summary'));
    assert.ok(output.includes('Total Targets:     3'));
    assert.ok(output.includes('Succeeded:         2'));
    assert.ok(output.includes('Failed:            1'));
    assert.ok(output.includes('Tenant 1'));
    assert.ok(output.includes('Relation "orders" does not exist'));
  });
});

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  calculateDecorrelatedJitter,
  isRetryableLockError,
  MigrationCircuitBreaker,
  CircuitBreakerPool,
} from '../../src/cluster/circuitBreaker.js';

describe('Circuit Breaker & Decorrelated Jitter Engine', () => {
  describe('calculateDecorrelatedJitter', () => {
    it('always bounds backoff within [baseMs, capMs]', () => {
      const baseMs = 50;
      const capMs = 1000;
      let prev = baseMs;

      for (let i = 0; i < 500; i++) {
        const next = calculateDecorrelatedJitter(baseMs, capMs, prev);
        assert.ok(next >= baseMs, `Value ${next} must be >= baseMs ${baseMs}`);
        assert.ok(next <= capMs, `Value ${next} must be <= capMs ${capMs}`);
        prev = next;
      }
    });

    it('handles prevSleepMs = 0 or negative gracefully', () => {
      const next = calculateDecorrelatedJitter(100, 5000, 0);
      assert.ok(next >= 100 && next <= 5000);

      const nextNeg = calculateDecorrelatedJitter(100, 5000, -50);
      assert.ok(nextNeg >= 100 && nextNeg <= 5000);
    });

    it('returns baseMs when baseMs === capMs', () => {
      const fixed = calculateDecorrelatedJitter(200, 200, 50);
      assert.strictEqual(fixed, 200);
    });

    it('exhibits non-deterministic jitter variation', () => {
      const values = new Set<number>();
      for (let i = 0; i < 50; i++) {
        values.add(calculateDecorrelatedJitter(50, 5000, 500));
      }
      // Over 50 iterations with wide cap, there should be multiple distinct values
      assert.ok(values.size > 5, 'Jitter should produce non-deterministic variations');
    });
  });

  describe('isRetryableLockError', () => {
    it('detects SQLSTATE 55P03 (lock_not_available)', () => {
      assert.strictEqual(isRetryableLockError({ code: '55P03' }), true);
      assert.strictEqual(isRetryableLockError({ sqlState: '55P03' }), true);
    });

    it('detects SQLSTATE 57014 (query_canceled)', () => {
      assert.strictEqual(isRetryableLockError({ code: '57014' }), true);
      assert.strictEqual(isRetryableLockError({ sqlState: '57014' }), true);
    });

    it('detects text indicators in error message', () => {
      assert.strictEqual(isRetryableLockError(new Error('canceling statement due to user request')), true);
      assert.strictEqual(isRetryableLockError(new Error('Lock timeout expired')), true);
      assert.strictEqual(isRetryableLockError(new Error('statement canceled')), true);
    });

    it('rejects non-retryable errors', () => {
      assert.strictEqual(isRetryableLockError(null), false);
      assert.strictEqual(isRetryableLockError(undefined), false);
      assert.strictEqual(isRetryableLockError(new Error('syntax error at or near "SELCT"')), false);
      assert.strictEqual(isRetryableLockError({ code: '42601' }), false);
    });
  });

  describe('MigrationCircuitBreaker lifecycle', () => {
    it('instantiates with custom or default thresholds', () => {
      const defaultBreaker = new MigrationCircuitBreaker();
      assert.strictEqual(defaultBreaker.maxQueueDepth, 5);
      assert.strictEqual(defaultBreaker.maxQueueWaitMs, 200);
      assert.strictEqual(defaultBreaker.pollIntervalMs, 50);

      const customBreaker = new MigrationCircuitBreaker({
        maxQueueDepth: 10,
        maxQueueWaitMs: 500,
        pollIntervalMs: 25,
      });
      assert.strictEqual(customBreaker.maxQueueDepth, 10);
      assert.strictEqual(customBreaker.maxQueueWaitMs, 500);
      assert.strictEqual(customBreaker.pollIntervalMs, 25);
    });

    it('successfully executes DDL when no contention occurs', async () => {
      const breaker = new MigrationCircuitBreaker({ pollIntervalMs: 10 });
      let successEventEmitted = false;

      breaker.on('success', () => {
        successEventEmitted = true;
      });

      const mockPool: CircuitBreakerPool = {
        async connect() {
          return {
            async query(sql: string) {
              if (sql.includes('pg_backend_pid')) {
                return { rows: [{ pid: 1234 }] };
              }
              if (sql.includes('queue_depth')) {
                return { rows: [{ queue_depth: 0, max_wait_ms: 0 }] };
              }
              return { rows: [] };
            },
            release() {},
          };
        },
      };

      const result = await breaker.executeWithPreemption(mockPool, 'CREATE TABLE test_tab (id int);');
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.attempts, 1);
      assert.strictEqual(successEventEmitted, true);
    });

    it('retries on retryable lock errors and succeeds on subsequent attempt', async () => {
      const breaker = new MigrationCircuitBreaker({ pollIntervalMs: 10 });
      let executionCount = 0;
      let retryEventEmitted = false;

      breaker.on('retry', () => {
        retryEventEmitted = true;
      });

      const mockPool: CircuitBreakerPool = {
        async connect() {
          return {
            async query(sql: string) {
              if (sql.includes('pg_backend_pid')) {
                return { rows: [{ pid: 5678 }] };
              }
              if (sql.includes('queue_depth')) {
                return { rows: [{ queue_depth: 0, max_wait_ms: 0 }] };
              }
              if (sql.includes('ALTER TABLE')) {
                executionCount++;
                if (executionCount === 1) {
                  const cancelErr = new Error('canceling statement due to user request');
                  (cancelErr as any).code = '57014';
                  throw cancelErr;
                }
                return { rows: [] };
              }
              return { rows: [] };
            },
            release() {},
          };
        },
      };

      const result = await breaker.executeWithPreemption(mockPool, 'ALTER TABLE users ADD COLUMN age int;', {
        maxRetries: 3,
        baseDelayMs: 10,
        capDelayMs: 50,
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.attempts, 2);
      assert.strictEqual(retryEventEmitted, true);
    });

    it('fails when retries are exhausted on persistent lock contention', async () => {
      const breaker = new MigrationCircuitBreaker({ pollIntervalMs: 10 });

      const mockPool: CircuitBreakerPool = {
        async connect() {
          return {
            async query(sql: string) {
              if (sql.includes('pg_backend_pid')) {
                return { rows: [{ pid: 9999 }] };
              }
              if (sql.includes('queue_depth')) {
                return { rows: [{ queue_depth: 0, max_wait_ms: 0 }] };
              }
              if (sql.includes('DROP TABLE')) {
                const lockErr = new Error('lock_not_available');
                (lockErr as any).code = '55P03';
                throw lockErr;
              }
              return { rows: [] };
            },
            release() {},
          };
        },
      };

      let abortEventEmitted = false;
      breaker.on('aborted', () => {
        abortEventEmitted = true;
      });

      const result = await breaker.executeWithPreemption(mockPool, 'DROP TABLE obsolete;', {
        maxRetries: 2,
        baseDelayMs: 5,
        capDelayMs: 15,
      });

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.attempts, 3);
      assert.ok(result.error);
      assert.strictEqual(abortEventEmitted, true);
    });
  });
});

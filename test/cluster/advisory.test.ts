/**
 * ddlforge — test/cluster/advisory.test.ts
 *
 * Unit tests for distributed advisory lock clustering:
 *   - 64-bit BigInt key derivation (signed two's complement, boundaries, collision resistance)
 *   - DistributedLockManager transaction and session locking lifecycle
 *   - Heartbeat and stale runner tracking
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateAdvisoryKey,
  DistributedLockManager,
  type PgClientLike,
} from '../../src/cluster/advisory.js';

describe('generateAdvisoryKey()', () => {
  it('returns a native BigInt', () => {
    const key = generateAdvisoryKey('my_project', 'migration_001');
    assert.strictEqual(typeof key, 'bigint');
  });

  it('is deterministic for identical project and namespace', () => {
    const key1 = generateAdvisoryKey('alpha', 'v1.0.0');
    const key2 = generateAdvisoryKey('alpha', 'v1.0.0');
    assert.strictEqual(key1, key2);
  });

  it('produces distinct keys for different namespaces within the same project', () => {
    const key1 = generateAdvisoryKey('alpha', 'migration_1');
    const key2 = generateAdvisoryKey('alpha', 'migration_2');
    assert.notStrictEqual(key1, key2);
  });

  it('produces distinct keys for the same namespace in different projects', () => {
    const key1 = generateAdvisoryKey('project_a', 'migration_1');
    const key2 = generateAdvisoryKey('project_b', 'migration_1');
    assert.notStrictEqual(key1, key2);
  });

  it('respects 64-bit signed integer boundaries (-2^63 to 2^63 - 1)', () => {
    const MIN_BIGINT64 = -9223372036854775808n;
    const MAX_BIGINT64 = 9223372036854775807n;

    for (let i = 0; i < 50; i++) {
      const key = generateAdvisoryKey(`project_${i}`, `ns_${i * 13}`);
      assert.ok(key >= MIN_BIGINT64, `Key ${key} below minimum 64-bit signed int`);
      assert.ok(key <= MAX_BIGINT64, `Key ${key} above maximum 64-bit signed int`);
    }
  });

  it('produces signed two-s complement values (both positive and negative)', () => {
    let hasPositive = false;
    let hasNegative = false;

    for (let i = 0; i < 100; i++) {
      const key = generateAdvisoryKey(`proj_${i}`, `batch_${i}`);
      if (key > 0n) hasPositive = true;
      if (key < 0n) hasNegative = true;
      if (hasPositive && hasNegative) break;
    }

    assert.ok(hasPositive, 'Expected at least one positive 64-bit BigInt key');
    assert.ok(hasNegative, 'Expected at least one negative 64-bit BigInt key');
  });

  it('handles empty strings and special characters without error', () => {
    const key1 = generateAdvisoryKey('', '');
    assert.strictEqual(typeof key1, 'bigint');

    const key2 = generateAdvisoryKey('my-project/prod::db', 'ns@test#1$');
    assert.strictEqual(typeof key2, 'bigint');
    assert.notStrictEqual(key1, key2);
  });
});

describe('DistributedLockManager', () => {
  function createMockClient(overrides: {
    tryXactLock?: boolean;
    trySessionLock?: boolean;
    unlockResult?: boolean;
    statusRows?: any[];
  } = {}): PgClientLike & { queries: string[]; params: unknown[][] } {
    const queries: string[] = [];
    const params: unknown[][] = [];

    return {
      queries,
      params,
      async query(sql: string, p?: unknown[]) {
        queries.push(sql);
        params.push(p ?? []);

        if (sql.includes('pg_try_advisory_xact_lock')) {
          return { rows: [{ acquired: overrides.tryXactLock ?? true }] };
        }
        if (sql.includes('pg_try_advisory_lock')) {
          return { rows: [{ acquired: overrides.trySessionLock ?? true }] };
        }
        if (sql.includes('pg_advisory_unlock')) {
          return { rows: [{ released: overrides.unlockResult ?? true }] };
        }
        if (sql.includes('FROM ddlforge_run')) {
          return { rows: overrides.statusRows ?? [] };
        }
        return { rows: [] };
      },
    };
  }

  it('ensureStateTable executes CREATE TABLE IF NOT EXISTS ddlforge_run', async () => {
    const client = createMockClient();
    const mgr = new DistributedLockManager();
    await mgr.ensureStateTable(client);

    assert.ok(client.queries.some(q => q.includes('CREATE TABLE IF NOT EXISTS ddlforge_run')));
  });

  it('acquireTransactionLock succeeds and records acquisition', async () => {
    const client = createMockClient({ tryXactLock: true });
    const mgr = new DistributedLockManager({ project: 'test_proj' });
    const key = generateAdvisoryKey('test_proj', 'test_ns');

    const acquired = await mgr.acquireTransactionLock(client, key, 1000, 50, {
      project: 'test_proj',
      namespace: 'test_ns',
    });

    assert.strictEqual(acquired, true);
    assert.ok(client.queries.some(q => q.includes('pg_try_advisory_xact_lock')));
    assert.ok(client.queries.some(q => q.includes('INSERT INTO ddlforge_run')));
  });

  it('acquireTransactionLock times out when lock cannot be acquired', async () => {
    const client = createMockClient({ tryXactLock: false });
    const mgr = new DistributedLockManager({ project: 'test_proj' });
    const key = generateAdvisoryKey('test_proj', 'test_ns');

    const acquired = await mgr.acquireTransactionLock(client, key, 100, 20);
    assert.strictEqual(acquired, false);
  });

  it('acquireSessionLock succeeds and releaseSessionLock unlocks', async () => {
    const client = createMockClient({ trySessionLock: true, unlockResult: true });
    const mgr = new DistributedLockManager({ project: 'test_proj' });
    const key = generateAdvisoryKey('test_proj', 'test_session');

    const acquired = await mgr.acquireSessionLock(client, key, 1000, 50, {
      project: 'test_proj',
      namespace: 'test_session',
    });
    assert.strictEqual(acquired, true);
    assert.ok(client.queries.some(q => q.includes('pg_try_advisory_lock')));

    const released = await mgr.releaseSessionLock(client, key, 'test_proj:test_session');
    assert.strictEqual(released, true);
    assert.ok(client.queries.some(q => q.includes('pg_advisory_unlock')));
    assert.ok(client.queries.some(q => q.includes("SET status = 'released'")));
  });

  it('startHeartbeat returns a cleanup function that stops updates', async () => {
    const client = createMockClient();
    const mgr = new DistributedLockManager();

    const stop = mgr.startHeartbeat(client, 'test_ns', 10);
    assert.strictEqual(typeof stop, 'function');
    stop(); // Clears interval without errors
  });

  it('getLockStatus categorizes active vs stale locks', async () => {
    const client = createMockClient({
      statusRows: [
        {
          lock_namespace: 'proj:ns1',
          lock_key: '1234567890',
          runner_id: 'runner_1',
          pid: 101,
          application_name: 'ddlforge',
          acquired_at: new Date().toISOString(),
          last_heartbeat: new Date().toISOString(),
          status: 'active',
          is_backend_alive: true,
          is_stale: false,
        },
        {
          lock_namespace: 'proj:ns2',
          lock_key: '9876543210',
          runner_id: 'runner_2',
          pid: 999,
          application_name: 'ddlforge',
          acquired_at: new Date(Date.now() - 60000).toISOString(),
          last_heartbeat: new Date(Date.now() - 60000).toISOString(),
          status: 'active',
          is_backend_alive: false,
          is_stale: true,
        },
      ],
    });

    const mgr = new DistributedLockManager({ project: 'proj' });
    const report = await mgr.getLockStatus(client, 'proj');

    assert.strictEqual(report.records.length, 2);
    assert.strictEqual(report.activeCount, 1);
    assert.strictEqual(report.staleCount, 1);
    assert.strictEqual(report.records[0].isStale, false);
    assert.strictEqual(report.records[1].isStale, true);
  });

  it('releaseStaleLocks clears orphaned records', async () => {
    const client = createMockClient({
      statusRows: [
        {
          lock_namespace: 'proj:orphaned',
          lock_key: '999999',
          runner_id: 'dead_runner',
          pid: 888,
          application_name: 'ddlforge',
          acquired_at: new Date(Date.now() - 100000).toISOString(),
          last_heartbeat: new Date(Date.now() - 100000).toISOString(),
          status: 'active',
          is_backend_alive: false,
          is_stale: true,
        },
      ],
      unlockResult: true,
    });

    const mgr = new DistributedLockManager({ project: 'proj' });
    const releaseReport = await mgr.releaseStaleLocks(client, { project: 'proj' });

    assert.strictEqual(releaseReport.clearedCount, 1);
    assert.ok(client.queries.some(q => q.includes("SET status = 'stale_cleared'")));
  });
});

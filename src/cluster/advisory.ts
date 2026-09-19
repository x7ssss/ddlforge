/**
 * ddlforge - Distributed Advisory Lock Clustering
 *
 * Provides collision-free 64-bit BigInt advisory lock key derivation and
 * transaction-scoped or session-scoped locking with connection pooler
 * safety (PgBouncer/Supavisor) and stale runner tracking via `ddlforge_run`.
 */

import { createHash, randomUUID } from 'node:crypto';

/**
 * Minimal pg Client interface required for advisory locking.
 */
export interface PgClientLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

export interface RunnerInfo {
  project?: string;
  namespace?: string;
  runnerId?: string;
  applicationName?: string;
}

export interface ActiveLockRecord {
  lockNamespace: string;
  lockKey: string;
  runnerId: string;
  pid: number;
  applicationName: string | null;
  acquiredAt: Date;
  lastHeartbeat: Date;
  status: string;
  isBackendAlive: boolean;
  isStale: boolean;
}

export interface LockStatusReport {
  records: ActiveLockRecord[];
  activeCount: number;
  staleCount: number;
}

export interface ReleaseReport {
  clearedCount: number;
  unlockedCount: number;
  details: string[];
}

/**
 * Derives a collision-free 64-bit signed BigInt key for PostgreSQL advisory locks.
 *
 * Uses Node.js crypto SHA-256 slice: `readBigInt64BE(0)` on `ddlforge\0v1\0<project>\0<namespace>`.
 * Returns a signed 64-bit integer (-2^63 to 2^63 - 1) matching PostgreSQL `bigint`.
 * Never uses 32-bit `hashtext()`.
 */
export function generateAdvisoryKey(project: string, namespace: string): bigint {
  const hash = createHash('sha256');
  hash.update(`ddlforge\0v1\0${project}\0${namespace}`);
  const digest = hash.digest();
  return digest.readBigInt64BE(0);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Distributed Lock Manager providing transaction-level and session-level
 * PostgreSQL advisory locking with active heartbeat monitoring.
 */
export class DistributedLockManager {
  private project: string;
  private runnerId: string;

  constructor(options: { project?: string; runnerId?: string } = {}) {
    this.project = options.project ?? 'default';
    this.runnerId = options.runnerId ?? `runner_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  }

  /**
   * Ensures the `ddlforge_run` state tracking table exists.
   */
  async ensureStateTable(client: PgClientLike): Promise<void> {
    const ddl = `
      CREATE TABLE IF NOT EXISTS ddlforge_run (
        lock_namespace TEXT PRIMARY KEY,
        lock_key BIGINT NOT NULL,
        runner_id TEXT NOT NULL,
        pid INTEGER NOT NULL,
        application_name TEXT,
        acquired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_heartbeat TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        status TEXT NOT NULL DEFAULT 'active'
      );
    `;
    await client.query(ddl);
  }

  /**
   * Acquires a transaction-scoped advisory lock:
   * `SELECT pg_try_advisory_xact_lock($1::bigint)`
   *
   * Transaction-scoped locks are automatically released at COMMIT/ROLLBACK,
   * making them safe for transaction-mode connection poolers (PgBouncer, Supavisor).
   */
  async acquireTransactionLock(
    client: PgClientLike,
    key: bigint,
    timeoutMs: number = 30000,
    intervalMs: number = 500,
    runnerInfo?: RunnerInfo
  ): Promise<boolean> {
    await this.ensureStateTable(client);

    const project = runnerInfo?.project ?? this.project;
    const namespace = runnerInfo?.namespace ?? 'global';
    const runnerId = runnerInfo?.runnerId ?? this.runnerId;
    const keyStr = key.toString();

    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      const res = await client.query(
        'SELECT pg_try_advisory_xact_lock($1::bigint) AS acquired',
        [keyStr]
      );
      const acquired = Boolean(res.rows[0]?.acquired);

      if (acquired) {
        await this.recordAcquisition(client, `${project}:${namespace}`, keyStr, runnerId);
        return true;
      }

      await sleep(intervalMs);
    }

    return false;
  }

  /**
   * Acquires a session-scoped advisory lock:
   * `SELECT pg_try_advisory_lock($1::bigint)`
   *
   * Used for multi-transaction / autocommit flows (e.g. `CREATE INDEX CONCURRENTLY`
   * or multi-phase orchestrations). Requires explicit release via `releaseSessionLock()`.
   */
  async acquireSessionLock(
    client: PgClientLike,
    key: bigint,
    timeoutMs: number = 30000,
    intervalMs: number = 500,
    runnerInfo?: RunnerInfo
  ): Promise<boolean> {
    await this.ensureStateTable(client);

    const project = runnerInfo?.project ?? this.project;
    const namespace = runnerInfo?.namespace ?? 'global';
    const runnerId = runnerInfo?.runnerId ?? this.runnerId;
    const keyStr = key.toString();

    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      const res = await client.query(
        'SELECT pg_try_advisory_lock($1::bigint) AS acquired',
        [keyStr]
      );
      const acquired = Boolean(res.rows[0]?.acquired);

      if (acquired) {
        await this.recordAcquisition(client, `${project}:${namespace}`, keyStr, runnerId);
        return true;
      }

      await sleep(intervalMs);
    }

    return false;
  }

  /**
   * Releases a session-scoped advisory lock and marks state as released.
   */
  async releaseSessionLock(
    client: PgClientLike,
    key: bigint,
    namespaceKey?: string
  ): Promise<boolean> {
    const keyStr = key.toString();
    const res = await client.query(
      'SELECT pg_advisory_unlock($1::bigint) AS released',
      [keyStr]
    );
    const released = Boolean(res.rows[0]?.released);

    if (namespaceKey) {
      await client.query(
        `UPDATE ddlforge_run
         SET status = 'released', last_heartbeat = NOW()
         WHERE lock_namespace = $1`,
        [namespaceKey]
      ).catch(() => {});
    }

    return released;
  }

  /**
   * Starts a periodic background heartbeat updater for an active lock.
   * Returns a cancellation function.
   */
  startHeartbeat(
    client: PgClientLike,
    lockNamespace: string,
    intervalMs: number = 5000
  ): () => void {
    let stopped = false;
    const interval = setInterval(async () => {
      if (stopped) return;
      try {
        await client.query(
          `UPDATE ddlforge_run
           SET last_heartbeat = NOW()
           WHERE lock_namespace = $1 AND status = 'active'`,
          [lockNamespace]
        );
      } catch {
        // Best-effort heartbeat
      }
    }, intervalMs);

    // Prevent hanging node process
    if (interval.unref) {
      interval.unref();
    }

    return () => {
      stopped = true;
      clearInterval(interval);
    };
  }

  /**
   * Inspects active advisory locks and reconciles them with `ddlforge_run`
   * and `pg_stat_activity` to report alive vs stale locks.
   */
  async getLockStatus(
    client: PgClientLike,
    filterProject?: string
  ): Promise<LockStatusReport> {
    await this.ensureStateTable(client);

    const query = `
      SELECT
        r.lock_namespace,
        r.lock_key,
        r.runner_id,
        r.pid,
        r.application_name,
        r.acquired_at,
        r.last_heartbeat,
        r.status,
        (a.pid IS NOT NULL) AS is_backend_alive,
        (NOW() - r.last_heartbeat > INTERVAL '30 seconds' OR a.pid IS NULL) AS is_stale
      FROM ddlforge_run r
      LEFT JOIN pg_stat_activity a ON a.pid = r.pid
      WHERE r.status = 'active'
        ${filterProject ? `AND r.lock_namespace LIKE $1` : ''}
      ORDER BY r.acquired_at DESC;
    `;

    const params = filterProject ? [`${filterProject}:%`] : [];
    const res = await client.query(query, params);

    const records: ActiveLockRecord[] = res.rows.map(row => ({
      lockNamespace: String(row['lock_namespace']),
      lockKey: String(row['lock_key']),
      runnerId: String(row['runner_id']),
      pid: Number(row['pid']),
      applicationName: row['application_name'] ? String(row['application_name']) : null,
      acquiredAt: new Date(row['acquired_at']),
      lastHeartbeat: new Date(row['last_heartbeat']),
      status: String(row['status']),
      isBackendAlive: Boolean(row['is_backend_alive']),
      isStale: Boolean(row['is_stale']),
    }));

    const activeCount = records.filter(r => !r.isStale).length;
    const staleCount = records.filter(r => r.isStale).length;

    return { records, activeCount, staleCount };
  }

  /**
   * Cleans stale runner tracking records and optionally unlocks abandoned session locks.
   */
  async releaseStaleLocks(
    client: PgClientLike,
    options: { project?: string; force?: boolean } = {}
  ): Promise<ReleaseReport> {
    const status = await this.getLockStatus(client, options.project);
    const staleRecords = status.records.filter(r => r.isStale || options.force);

    let clearedCount = 0;
    let unlockedCount = 0;
    const details: string[] = [];

    for (const rec of staleRecords) {
      // Attempt advisory unlock if possible
      try {
        const unlockRes = await client.query(
          'SELECT pg_advisory_unlock($1::bigint) AS released',
          [rec.lockKey]
        );
        if (unlockRes.rows[0]?.released) {
          unlockedCount++;
          details.push(`Unlocked session key ${rec.lockKey} for namespace "${rec.lockNamespace}"`);
        }
      } catch {
        // Unlock might fail if not held by current session; proceed
      }

      // Mark status as stale_cleared in ddlforge_run
      await client.query(
        `UPDATE ddlforge_run
         SET status = 'stale_cleared', last_heartbeat = NOW()
         WHERE lock_namespace = $1`,
        [rec.lockNamespace]
      );
      clearedCount++;
      details.push(`Cleared stale run record for namespace "${rec.lockNamespace}" (PID ${rec.pid})`);
    }

    return { clearedCount, unlockedCount, details };
  }

  private async recordAcquisition(
    client: PgClientLike,
    lockNamespace: string,
    keyStr: string,
    runnerId: string
  ): Promise<void> {
    const sql = `
      INSERT INTO ddlforge_run (lock_namespace, lock_key, runner_id, pid, application_name, acquired_at, last_heartbeat, status)
      VALUES ($1, $2::bigint, $3, pg_backend_pid(), current_setting('application_name', true), NOW(), NOW(), 'active')
      ON CONFLICT (lock_namespace) DO UPDATE
        SET lock_key = EXCLUDED.lock_key,
            runner_id = EXCLUDED.runner_id,
            pid = EXCLUDED.pid,
            application_name = EXCLUDED.application_name,
            acquired_at = NOW(),
            last_heartbeat = NOW(),
            status = 'active';
    `;
    await client.query(sql, [lockNamespace, keyStr, runnerId]);
  }
}

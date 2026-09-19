/**
 * ddlforge - Pre-flight Replication Lag & WAL Throttler
 *
 * Implements 64-bit BigInt Log Sequence Number (LSN) parsing without floating-point
 * precision degradation, and backfill throttling logic when replica replay lag
 * exceeds safe byte or duration thresholds.
 *
 * Architectural Foundations:
 * - BigInt LSN Handling: Native JavaScript BigInt parsing of `pg_wal_lsn_diff()` outputs
 *   and raw hex LSN pairs (`XX/YYYYYYYY`) to prevent precision loss on 64-bit values.
 * - Dynamic Replication Throttler: Proactive lag detection on `pg_stat_replication` standbys
 *   throttles heavy DDL/backfill loops before replica buffers overflow or disconnect.
 */

import type { PgClientLike } from '../cluster/advisory.js';

export interface ReplicaStatus {
  applicationName: string;
  clientAddr: string | null;
  state: string; // e.g. 'streaming', 'catchup', 'backup'
  syncState: string; // 'sync', 'async', 'potential', 'quorum'
  sentLsn: string | null;
  writeLsn: string | null;
  flushLsn: string | null;
  replayLsn: string | null;
  replayLagBytes: bigint;
  replayLagSeconds: number;
}

export interface ReplicationThrottleOptions {
  /** Maximum allowable replay lag in bytes before throttling (default: 100MB = 104857600n) */
  maxLagBytes?: bigint;
  /** Maximum allowable replay lag in seconds before throttling (default: 10s) */
  maxLagSeconds?: number;
  /** Base backoff throttle sleep in ms (default: 500ms) */
  baseThrottleMs?: number;
  /** Maximum throttle sleep cap in ms (default: 10000ms) */
  maxThrottleMs?: number;
  /** Only throttle on synchronous standbys (default: false) */
  syncOnly?: boolean;
}

export interface LaggingReplicaDetail {
  applicationName: string;
  clientAddr: string | null;
  syncState: string;
  lagBytes: bigint;
  lagSeconds: number;
  exceededMetric: 'BYTES' | 'DURATION' | 'BOTH';
  detail: string;
}

export interface ReplicationThrottleDecision {
  shouldThrottle: boolean;
  reason?: string;
  recommendedThrottleMs: number;
  replicaCount: number;
  maxObservedLagBytes: bigint;
  maxObservedLagSeconds: number;
  laggingReplicas: LaggingReplicaDetail[];
}

/**
 * Parses a PostgreSQL hex LSN string (e.g. '16/B374D848', '0/16B3748') into a native 64-bit BigInt.
 * Preserves exact single-byte precision across the full 64-bit range.
 */
export function parseLsnToBigInt(lsn: string): bigint {
  if (!lsn || typeof lsn !== 'string') {
    throw new Error(`parseLsnToBigInt: Invalid LSN input: ${lsn}`);
  }

  const trimmed = lsn.trim();
  const parts = trimmed.split('/');
  if (parts.length !== 2 || !/^[0-9A-Fa-f]+$/.test(parts[0]) || !/^[0-9A-Fa-f]+$/.test(parts[1])) {
    throw new Error(`parseLsnToBigInt: Malformed PostgreSQL LSN string: "${lsn}"`);
  }

  const high = BigInt('0x' + parts[0]);
  const low = BigInt('0x' + parts[1]);

  return (high << 32n) + low;
}

/**
 * Converts a 64-bit BigInt value back into PostgreSQL hex LSN representation (XX/YYYYYYYY).
 */
export function bigIntToLsn(val: bigint): string {
  if (typeof val !== 'bigint') {
    val = BigInt(val);
  }
  if (val < 0n) {
    throw new Error(`bigIntToLsn: Negative BigInt value cannot be converted to LSN: ${val}`);
  }

  const high = (val >> 32n).toString(16).toUpperCase();
  const low = (val & 0xFFFFFFFFn).toString(16).toUpperCase().padStart(8, '0');

  return `${high}/${low}`;
}

/**
 * Calculates the exact byte difference between two PostgreSQL LSN strings using native BigInt arithmetic.
 * Equivalent to `pg_wal_lsn_diff(currentLsn, targetLsn)` in PostgreSQL.
 */
export function calculateLsnDiff(currentLsn: string, targetLsn: string): bigint {
  const current = parseLsnToBigInt(currentLsn);
  const target = parseLsnToBigInt(targetLsn);
  return current - target;
}

/**
 * Safely parses replication lag bytes from database query rows (string, number, or bigint) into BigInt.
 */
export function parseReplicationLagBytes(raw: unknown): bigint {
  if (raw === null || raw === undefined) return 0n;
  if (typeof raw === 'bigint') return raw;
  if (typeof raw === 'number') return BigInt(Math.max(0, Math.floor(raw)));

  const str = String(raw).trim();
  if (str === '') return 0n;

  // If floating-point representation, truncate decimals before BigInt conversion
  const intPart = str.split('.')[0];
  try {
    return BigInt(intPart);
  } catch {
    return 0n;
  }
}

/**
 * Evaluates replication lag metrics across all connected standbys and determines whether
 * backfills or DDL operations must throttle to prevent replica disconnection or lag runaway.
 */
export function evaluateReplicationThrottle(
  replicas: ReplicaStatus[],
  options: ReplicationThrottleOptions = {}
): ReplicationThrottleDecision {
  const maxLagBytes = options.maxLagBytes ?? 104857600n; // 100 MB
  const maxLagSeconds = options.maxLagSeconds ?? 10; // 10 seconds
  const baseThrottleMs = options.baseThrottleMs ?? 500;
  const maxThrottleMs = options.maxThrottleMs ?? 10000;
  const syncOnly = options.syncOnly ?? false;

  if (!replicas || replicas.length === 0) {
    return {
      shouldThrottle: false,
      reason: 'No active replication standbys connected.',
      recommendedThrottleMs: 0,
      replicaCount: 0,
      maxObservedLagBytes: 0n,
      maxObservedLagSeconds: 0,
      laggingReplicas: [],
    };
  }

  let maxObservedLagBytes = 0n;
  let maxObservedLagSeconds = 0;
  const laggingReplicas: LaggingReplicaDetail[] = [];

  for (const replica of replicas) {
    if (syncOnly && replica.syncState !== 'sync') {
      continue;
    }

    if (replica.replayLagBytes > maxObservedLagBytes) {
      maxObservedLagBytes = replica.replayLagBytes;
    }
    if (replica.replayLagSeconds > maxObservedLagSeconds) {
      maxObservedLagSeconds = replica.replayLagSeconds;
    }

    const exceedsBytes = replica.replayLagBytes > maxLagBytes;
    const exceedsTime = replica.replayLagSeconds > maxLagSeconds;

    if (exceedsBytes || exceedsTime) {
      let exceededMetric: 'BYTES' | 'DURATION' | 'BOTH' = 'BOTH';
      if (exceedsBytes && !exceedsTime) exceededMetric = 'BYTES';
      if (!exceedsBytes && exceedsTime) exceededMetric = 'DURATION';

      const byteMb = (Number(replica.replayLagBytes) / (1024 * 1024)).toFixed(1);
      const detail = `Standby "${replica.applicationName}" (${replica.clientAddr || 'local'}, ${replica.syncState}) lag: ${byteMb} MB / ${replica.replayLagSeconds.toFixed(1)}s (thresholds: ${(Number(maxLagBytes) / (1024 * 1024)).toFixed(0)} MB / ${maxLagSeconds}s)`;

      laggingReplicas.push({
        applicationName: replica.applicationName,
        clientAddr: replica.clientAddr,
        syncState: replica.syncState,
        lagBytes: replica.replayLagBytes,
        lagSeconds: replica.replayLagSeconds,
        exceededMetric,
        detail,
      });
    }
  }

  if (laggingReplicas.length === 0) {
    return {
      shouldThrottle: false,
      recommendedThrottleMs: 0,
      replicaCount: replicas.length,
      maxObservedLagBytes,
      maxObservedLagSeconds,
      laggingReplicas: [],
    };
  }

  // Dynamic backoff throttle: scale throttle sleep proportionally with lag excess
  const byteLagRatio = Number(maxObservedLagBytes) / Number(maxLagBytes || 1n);
  const timeLagRatio = maxObservedLagSeconds / (maxLagSeconds || 1);
  const maxRatio = Math.max(byteLagRatio, timeLagRatio);

  const recommendedThrottleMs = Math.min(
    maxThrottleMs,
    Math.max(baseThrottleMs, Math.floor(baseThrottleMs * Math.min(10, maxRatio)))
  );

  const reason = `Replication lag threshold exceeded on ${laggingReplicas.length} standby node(s). Recommended throttle delay: ${recommendedThrottleMs}ms.`;

  return {
    shouldThrottle: true,
    reason,
    recommendedThrottleMs,
    replicaCount: replicas.length,
    maxObservedLagBytes,
    maxObservedLagSeconds,
    laggingReplicas,
  };
}

/**
 * Queries `pg_stat_replication` directly from PostgreSQL and formats standby metrics.
 */
export async function queryReplicationStatus(client: PgClientLike): Promise<ReplicaStatus[]> {
  const sql = `
    SELECT
      application_name,
      client_addr::text AS client_addr,
      state,
      sync_state,
      sent_lsn::text AS sent_lsn,
      write_lsn::text AS write_lsn,
      flush_lsn::text AS flush_lsn,
      replay_lsn::text AS replay_lsn,
      COALESCE(pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn), 0)::text AS replay_lag_bytes,
      COALESCE(EXTRACT(EPOCH FROM replay_lag), 0)::numeric AS replay_lag_seconds
    FROM pg_stat_replication;
  `;

  const res = await client.query(sql);

  return res.rows.map((row: any): ReplicaStatus => ({
    applicationName: row.application_name || 'walreceiver',
    clientAddr: row.client_addr || null,
    state: row.state || 'streaming',
    syncState: row.sync_state || 'async',
    sentLsn: row.sent_lsn || null,
    writeLsn: row.write_lsn || null,
    flushLsn: row.flush_lsn || null,
    replayLsn: row.replay_lsn || null,
    replayLagBytes: parseReplicationLagBytes(row.replay_lag_bytes),
    replayLagSeconds: parseFloat(row.replay_lag_seconds || '0') || 0,
  }));
}

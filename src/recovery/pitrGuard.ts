/**
 * ddlforge - Continuous WAL Archiving & Replication Slot Health Guard
 *
 * Inspects pg_stat_archiver, pg_replication_slots, and standby LSN replay lag
 * to prevent high-risk DDL execution on unrecoverable or failing database clusters.
 *
 * Architectural Foundations:
 * - Silent Backup Antipattern: A backup system does not exist unless continuous
 *   WAL archiving and replica replication are verified.
 * - Archiver Health State Machine: Accurately classifies status as HEALTHY,
 *   RECOVERED, FAILING_NOW, STALE_ARCHIVE, or NEVER_ARCHIVED.
 * - Replication Slot Bloat: Detects dangerous slot states (extended, unreserved, lost)
 *   and inactive slots retaining WAL that risk out-of-disk panics.
 */

import type { PgClientLike } from '../cluster/advisory.js';
import { parseLsnToBigInt, calculateLsnDiff } from '../preflight/replicationGuard.js';

export type ArchiverHealthStatus =
  | 'HEALTHY'
  | 'RECOVERED'
  | 'FAILING_NOW'
  | 'STALE_ARCHIVE'
  | 'NEVER_ARCHIVED';

export interface ArchiverStat {
  archivedCount: bigint;
  lastArchivedWal: string | null;
  lastArchivedTime: Date | null;
  failedCount: bigint;
  lastFailedWal: string | null;
  lastFailedTime: Date | null;
  statsReset: Date | null;
}

export interface ArchiverHealthReport {
  status: ArchiverHealthStatus;
  archivedCount: bigint;
  failedCount: bigint;
  lastArchivedWal: string | null;
  lastArchivedTime: Date | null;
  lastFailedWal: string | null;
  lastFailedTime: Date | null;
  secondsSinceLastArchive: number | null;
  secondsSinceLastFailure: number | null;
  isHealthy: boolean;
  message: string;
}

export interface ReplicationSlotInfo {
  slotName: string;
  plugin: string | null;
  slotType: 'physical' | 'logical' | string;
  active: boolean;
  temporary: boolean;
  walStatus: 'normal' | 'extended' | 'unreserved' | 'lost' | string | null;
  restartLsn: string | null;
  confirmedFlushLsn: string | null;
  retainedBytes: bigint;
  isDangerous: boolean;
  dangerReason?: string;
}

export interface SlotHealthReport {
  slots: ReplicationSlotInfo[];
  hasDangerousSlots: boolean;
  hasInactiveSlots: boolean;
  totalRetainedBytes: bigint;
  dangerousSlots: ReplicationSlotInfo[];
  inactiveSlots: ReplicationSlotInfo[];
}

export interface StandbyReplayLag {
  applicationName: string;
  clientAddr: string | null;
  state: string;
  syncState: string;
  currentWalLsn: string;
  replayLsn: string | null;
  replayLagBytes: bigint;
  replayLagMb: number;
}

export interface StandbyLsnReport {
  currentWalLsn: string;
  standbys: StandbyReplayLag[];
  maxReplayLagBytes: bigint;
  maxReplayLagMb: number;
  hasLaggingStandby: boolean;
}

export interface DisasterReadinessOptions {
  staleArchiveIntervalMs?: number; // default: 15 minutes = 900,000 ms
  failureThresholdIntervalMs?: number; // default: 1 hour = 3,600,000 ms
  maxSlotRetainedBytes?: bigint; // default: 1 GB = 1073741824n
  maxStandbyLagBytes?: bigint; // default: 100 MB = 104857600n
  now?: Date;
}

export interface DisasterReadinessReport {
  archiver: ArchiverHealthReport;
  replicationSlots: SlotHealthReport;
  standbys: StandbyLsnReport;
  isReady: boolean;
  blockers: string[];
  warnings: string[];
  checkedAt: Date;
}

/**
 * Classifies the health status of PostgreSQL continuous WAL archiving based on pg_stat_archiver metrics.
 */
export function classifyArchiverStatus(
  stat: Partial<ArchiverStat>,
  now: Date = new Date(),
  options: { staleIntervalMs?: number; failureIntervalMs?: number } = {}
): ArchiverHealthStatus {
  const staleIntervalMs = options.staleIntervalMs ?? 15 * 60 * 1000; // 15 mins
  const failureIntervalMs = options.failureIntervalMs ?? 60 * 60 * 1000; // 1 hour

  const archivedCount = stat.archivedCount ?? 0n;
  const failedCount = stat.failedCount ?? 0n;
  const lastArchivedTime = stat.lastArchivedTime ?? null;
  const lastFailedTime = stat.lastFailedTime ?? null;
  const lastArchivedWal = stat.lastArchivedWal ?? null;

  // Case 1: NEVER_ARCHIVED - Zero archives have occurred
  if (archivedCount === 0n && !lastArchivedWal && !lastArchivedTime) {
    if (failedCount > 0n || lastFailedTime) {
      return 'FAILING_NOW';
    }
    return 'NEVER_ARCHIVED';
  }

  // Case 2: FAILING_NOW or RECOVERED - Past or current failures recorded
  if (failedCount > 0n && lastFailedTime) {
    const failureAgeMs = now.getTime() - lastFailedTime.getTime();
    const isRecentFailure = failureAgeMs <= failureIntervalMs;

    if (!lastArchivedTime || lastFailedTime.getTime() >= lastArchivedTime.getTime()) {
      // The latest event was a failure
      if (isRecentFailure || !lastArchivedTime) {
        return 'FAILING_NOW';
      }
    } else {
      // lastArchivedTime > lastFailedTime:
      // An archive succeeded AFTER the failure, demonstrating recovery
      const archiveAgeMs = now.getTime() - lastArchivedTime.getTime();
      if (archiveAgeMs > staleIntervalMs) {
        return 'STALE_ARCHIVE';
      }
      return 'RECOVERED';
    }
  }

  // Case 3: Archive exists without recent failures. Check staleness.
  if (lastArchivedTime) {
    const archiveAgeMs = now.getTime() - lastArchivedTime.getTime();
    if (archiveAgeMs > staleIntervalMs) {
      return 'STALE_ARCHIVE';
    }
    return 'HEALTHY';
  }

  return archivedCount > 0n ? 'HEALTHY' : 'NEVER_ARCHIVED';
}

/**
 * Builds a comprehensive ArchiverHealthReport from raw archiver statistics.
 */
export function evaluateArchiverHealth(
  stat: ArchiverStat,
  options: { staleIntervalMs?: number; failureIntervalMs?: number; now?: Date } = {}
): ArchiverHealthReport {
  const now = options.now ?? new Date();
  const status = classifyArchiverStatus(stat, now, options);

  const secondsSinceLastArchive = stat.lastArchivedTime
    ? Math.max(0, Math.floor((now.getTime() - stat.lastArchivedTime.getTime()) / 1000))
    : null;

  const secondsSinceLastFailure = stat.lastFailedTime
    ? Math.max(0, Math.floor((now.getTime() - stat.lastFailedTime.getTime()) / 1000))
    : null;

  let message = '';
  switch (status) {
    case 'HEALTHY':
      message = `WAL archiving is healthy (${stat.archivedCount} segments archived, last archived ${secondsSinceLastArchive ?? 0}s ago).`;
      break;
    case 'RECOVERED':
      message = `WAL archiving has recovered from previous failures (${stat.failedCount} past failures, last archived ${secondsSinceLastArchive ?? 0}s ago).`;
      break;
    case 'FAILING_NOW':
      message = `WAL archiving is FAILING NOW (${stat.failedCount} failures recorded, last failure ${secondsSinceLastFailure ?? 0}s ago on WAL ${stat.lastFailedWal ?? 'unknown'}).`;
      break;
    case 'STALE_ARCHIVE':
      message = `WAL archiving is STALE (last archived ${Math.floor((secondsSinceLastArchive ?? 0) / 60)} minutes ago, exceeding threshold).`;
      break;
    case 'NEVER_ARCHIVED':
      message = 'WAL archiving has never run or archive_command is unconfigured on this instance.';
      break;
  }

  return {
    status,
    archivedCount: stat.archivedCount,
    failedCount: stat.failedCount,
    lastArchivedWal: stat.lastArchivedWal,
    lastArchivedTime: stat.lastArchivedTime,
    lastFailedWal: stat.lastFailedWal,
    lastFailedTime: stat.lastFailedTime,
    secondsSinceLastArchive,
    secondsSinceLastFailure,
    isHealthy: status === 'HEALTHY' || status === 'RECOVERED',
    message,
  };
}

/**
 * Evaluates the safety of replication slots, detecting inactive slots or dangerous WAL statuses.
 */
export function evaluateSlotHealth(
  slots: ReplicationSlotInfo[],
  options: { maxRetainedBytes?: bigint } = {}
): SlotHealthReport {
  const maxRetainedBytes = options.maxRetainedBytes ?? 1073741824n; // 1 GB
  const dangerousSlots: ReplicationSlotInfo[] = [];
  const inactiveSlots: ReplicationSlotInfo[] = [];
  let totalRetainedBytes = 0n;

  for (const slot of slots) {
    totalRetainedBytes += slot.retainedBytes;

    let isDangerous = false;
    let dangerReason: string | undefined;

    // Check wal_status for hazardous states
    const status = (slot.walStatus || '').toLowerCase();
    if (status === 'lost') {
      isDangerous = true;
      dangerReason = `Slot "${slot.slotName}" has lost required WAL segments and standby is unrecoverable.`;
    } else if (status === 'unreserved') {
      isDangerous = true;
      dangerReason = `Slot "${slot.slotName}" is in unreserved status; WAL files may be removed during checkpoint.`;
    } else if (status === 'extended') {
      isDangerous = true;
      dangerReason = `Slot "${slot.slotName}" is in extended status exceeding max_slot_wal_keep_size.`;
    } else if (!slot.active && slot.retainedBytes > maxRetainedBytes) {
      isDangerous = true;
      const retainedMb = Number(slot.retainedBytes / 1048576n);
      dangerReason = `Inactive slot "${slot.slotName}" is pinning ${retainedMb} MB of WAL files, risking out-of-disk panics.`;
    }

    if (!slot.active) {
      inactiveSlots.push(slot);
    }

    if (isDangerous) {
      slot.isDangerous = true;
      slot.dangerReason = dangerReason;
      dangerousSlots.push(slot);
    }
  }

  return {
    slots,
    hasDangerousSlots: dangerousSlots.length > 0,
    hasInactiveSlots: inactiveSlots.length > 0,
    totalRetainedBytes,
    dangerousSlots,
    inactiveSlots,
  };
}

/**
 * Queries pg_stat_archiver metrics from PostgreSQL.
 */
export async function queryArchiverStatus(client: PgClientLike): Promise<ArchiverStat> {
  const sql = `
    SELECT
      COALESCE(archived_count, 0)::text AS archived_count,
      last_archived_wal,
      last_archived_time,
      COALESCE(failed_count, 0)::text AS failed_count,
      last_failed_wal,
      last_failed_time,
      stats_reset
    FROM pg_stat_archiver;
  `;

  const res = await client.query(sql);
  const row = res.rows[0];

  if (!row) {
    return {
      archivedCount: 0n,
      lastArchivedWal: null,
      lastArchivedTime: null,
      failedCount: 0n,
      lastFailedWal: null,
      lastFailedTime: null,
      statsReset: null,
    };
  }

  return {
    archivedCount: BigInt(row.archived_count || '0'),
    lastArchivedWal: row.last_archived_wal ?? null,
    lastArchivedTime: row.last_archived_time ? new Date(row.last_archived_time) : null,
    failedCount: BigInt(row.failed_count || '0'),
    lastFailedWal: row.last_failed_wal ?? null,
    lastFailedTime: row.last_failed_time ? new Date(row.last_failed_time) : null,
    statsReset: row.stats_reset ? new Date(row.stats_reset) : null,
  };
}

/**
 * Queries pg_replication_slots metrics and calculates retained WAL byte volume.
 */
export async function queryReplicationSlots(
  client: PgClientLike,
  currentLsn?: string
): Promise<ReplicationSlotInfo[]> {
  // If currentLsn is not passed, query current WAL LSN
  let curLsn = currentLsn;
  if (!curLsn) {
    const lsnRes = await client.query(`
      SELECT CASE
        WHEN pg_is_in_recovery() THEN pg_last_wal_replay_lsn()::text
        ELSE pg_current_wal_lsn()::text
      END AS cur_lsn;
    `);
    curLsn = lsnRes.rows[0]?.cur_lsn || '0/0';
  }

  const sql = `
    SELECT
      slot_name,
      plugin,
      slot_type,
      active,
      temporary,
      restart_lsn::text AS restart_lsn,
      confirmed_flush_lsn::text AS confirmed_flush_lsn,
      COALESCE((
        SELECT wal_status FROM (
          SELECT column_name AS c FROM information_schema.columns
          WHERE table_name = 'pg_replication_slots' AND column_name = 'wal_status'
        ) cols
      ), 'normal') AS _has_col
    FROM pg_replication_slots;
  `;

  // Safely query all columns
  let rawRows: any[] = [];
  try {
    const res = await client.query('SELECT * FROM pg_replication_slots;');
    rawRows = res.rows;
  } catch (err: any) {
    // If pg_replication_slots is inaccessible or restricted, return empty
    return [];
  }

  return rawRows.map(row => {
    let retainedBytes = 0n;
    if (row.restart_lsn && curLsn && curLsn !== '0/0') {
      try {
        retainedBytes = calculateLsnDiff(curLsn, row.restart_lsn);
        if (retainedBytes < 0n) retainedBytes = 0n;
      } catch {
        retainedBytes = 0n;
      }
    }

    return {
      slotName: row.slot_name,
      plugin: row.plugin ?? null,
      slotType: row.slot_type,
      active: Boolean(row.active),
      temporary: Boolean(row.temporary),
      walStatus: row.wal_status ?? 'normal',
      restartLsn: row.restart_lsn ? String(row.restart_lsn) : null,
      confirmedFlushLsn: row.confirmed_flush_lsn ? String(row.confirmed_flush_lsn) : null,
      retainedBytes,
      isDangerous: false,
    };
  });
}

/**
 * Queries standby replay locations and computes LSN distance from the primary WAL position.
 */
export async function queryStandbyLsnStatus(
  client: PgClientLike,
  options: { maxStandbyLagBytes?: bigint } = {}
): Promise<StandbyLsnReport> {
  const maxStandbyLagBytes = options.maxStandbyLagBytes ?? 104857600n; // 100 MB

  const lsnRes = await client.query(`
    SELECT CASE
      WHEN pg_is_in_recovery() THEN pg_last_wal_replay_lsn()::text
      ELSE pg_current_wal_lsn()::text
    END AS cur_lsn;
  `);
  const currentWalLsn = lsnRes.rows[0]?.cur_lsn || '0/0';

  const repRes = await client.query(`
    SELECT
      application_name,
      client_addr::text AS client_addr,
      state,
      sync_state,
      replay_lsn::text AS replay_lsn
    FROM pg_stat_replication;
  `);

  let maxReplayLagBytes = 0n;
  const standbys: StandbyReplayLag[] = [];

  for (const row of repRes.rows) {
    let replayLagBytes = 0n;
    if (row.replay_lsn && currentWalLsn !== '0/0') {
      try {
        replayLagBytes = calculateLsnDiff(currentWalLsn, row.replay_lsn);
        if (replayLagBytes < 0n) replayLagBytes = 0n;
      } catch {
        replayLagBytes = 0n;
      }
    }

    if (replayLagBytes > maxReplayLagBytes) {
      maxReplayLagBytes = replayLagBytes;
    }

    standbys.push({
      applicationName: row.application_name || 'unknown',
      clientAddr: row.client_addr ?? null,
      state: row.state || 'unknown',
      syncState: row.sync_state || 'async',
      currentWalLsn,
      replayLsn: row.replay_lsn ?? null,
      replayLagBytes,
      replayLagMb: Number(replayLagBytes / (1024n * 1024n)),
    });
  }

  return {
    currentWalLsn,
    standbys,
    maxReplayLagBytes,
    maxReplayLagMb: Number(maxReplayLagBytes / (1024n * 1024n)),
    hasLaggingStandby: maxReplayLagBytes > maxStandbyLagBytes,
  };
}

/**
 * Runs a complete disaster recovery readiness audit on the connected cluster.
 */
export async function auditDisasterReadiness(
  client: PgClientLike,
  options: DisasterReadinessOptions = {}
): Promise<DisasterReadinessReport> {
  const now = options.now ?? new Date();

  // 1. Audit Archiver
  const archiverStat = await queryArchiverStatus(client);
  const archiver = evaluateArchiverHealth(archiverStat, {
    now,
    staleIntervalMs: options.staleArchiveIntervalMs,
    failureIntervalMs: options.failureThresholdIntervalMs,
  });

  // 2. Audit Standby LSN
  const standbys = await queryStandbyLsnStatus(client, {
    maxStandbyLagBytes: options.maxStandbyLagBytes,
  });

  // 3. Audit Replication Slots
  const rawSlots = await queryReplicationSlots(client, standbys.currentWalLsn);
  const replicationSlots = evaluateSlotHealth(rawSlots, {
    maxRetainedBytes: options.maxSlotRetainedBytes,
  });

  const blockers: string[] = [];
  const warnings: string[] = [];

  // Evaluate Archiver blockers / warnings
  if (archiver.status === 'FAILING_NOW') {
    blockers.push(
      `WAL archiving is FAILING NOW (${archiver.failedCount} failures, last failure at ${archiver.lastFailedTime?.toISOString() || 'unknown'}). Point-in-time recovery is compromised.`
    );
  } else if (archiver.status === 'NEVER_ARCHIVED') {
    warnings.push(
      'WAL archiving has never run on this instance. Continuous disaster recovery is unconfigured.'
    );
  } else if (archiver.status === 'STALE_ARCHIVE') {
    warnings.push(
      `WAL archiving is STALE (last archived ${Math.floor((archiver.secondsSinceLastArchive ?? 0) / 60)} minutes ago).`
    );
  }

  // Evaluate Replication Slot blockers / warnings
  for (const slot of replicationSlots.dangerousSlots) {
    blockers.push(`Replication slot hazard: ${slot.dangerReason}`);
  }

  for (const slot of replicationSlots.inactiveSlots) {
    if (!slot.isDangerous) {
      warnings.push(
        `Replication slot "${slot.slotName}" is inactive (retaining ${Number(slot.retainedBytes / 1048576n)} MB WAL).`
      );
    }
  }

  // Evaluate Standby Lag
  if (standbys.hasLaggingStandby) {
    blockers.push(
      `Standby replication replay lag exceeds threshold (${standbys.maxReplayLagMb} MB observed lag).`
    );
  }

  return {
    archiver,
    replicationSlots,
    standbys,
    isReady: blockers.length === 0,
    blockers,
    warnings,
    checkedAt: now,
  };
}

/**
 * Formats a DisasterReadinessReport into a colorized, human-readable terminal output.
 */
export function formatDoctorReportTerminal(report: DisasterReadinessReport): string {
  const lines: string[] = [];

  lines.push('');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('  ddlforge v1.6.0 — Continuous WAL Archiving & Disaster Readiness Doctor');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push(`Checked:    ${report.checkedAt.toISOString()}`);
  lines.push('');

  // 1. Archiver
  lines.push('[1] CONTINUOUS WAL ARCHIVING (pg_stat_archiver)');
  const archBadge = `[${report.archiver.status}]`;
  lines.push(`  Status:                    ${archBadge} - ${report.archiver.message}`);
  lines.push(`  Archived Segments:         ${report.archiver.archivedCount}`);
  lines.push(`  Failed Archive Count:      ${report.archiver.failedCount}`);
  if (report.archiver.lastArchivedWal) {
    lines.push(`  Last Archived WAL:         ${report.archiver.lastArchivedWal} (${report.archiver.lastArchivedTime?.toISOString() || 'unknown'})`);
  }
  if (report.archiver.lastFailedWal) {
    lines.push(`  Last Failed WAL:           ${report.archiver.lastFailedWal} (${report.archiver.lastFailedTime?.toISOString() || 'unknown'})`);
  }
  lines.push('');

  // 2. Replication Slots
  lines.push('[2] REPLICATION SLOTS & WAL RETENTION (pg_replication_slots)');
  if (report.replicationSlots.slots.length === 0) {
    lines.push('  No replication slots configured on this instance.');
  } else {
    for (const slot of report.replicationSlots.slots) {
      const statusTag = slot.isDangerous
        ? `[DANGEROUS: ${slot.walStatus || 'hazard'}]`
        : slot.active
        ? '[ACTIVE]'
        : '[INACTIVE]';
      const retainedMb = Number(slot.retainedBytes / 1048576n);
      lines.push(`  - Slot: ${slot.slotName} (${slot.slotType}) ${statusTag}`);
      lines.push(`    WAL Status: ${slot.walStatus || 'normal'} | Retained WAL: ${retainedMb} MB | Restart LSN: ${slot.restartLsn || 'N/A'}`);
      if (slot.dangerReason) {
        lines.push(`    ⚠ Hazard: ${slot.dangerReason}`);
      }
    }
  }
  lines.push('');

  // 3. Standby Replay Lag & LSN Distance
  lines.push('[3] STANDBY REPLICATION & LSN DISTANCE (pg_stat_replication)');
  lines.push(`  Current WAL LSN:           ${report.standbys.currentWalLsn}`);
  if (report.standbys.standbys.length === 0) {
    lines.push('  No active streaming standbys connected.');
  } else {
    for (const st of report.standbys.standbys) {
      lines.push(`  - Standby: ${st.applicationName} (${st.clientAddr || 'local'}) [${st.syncState}]`);
      lines.push(`    State: ${st.state} | Replay LSN: ${st.replayLsn || 'N/A'} | Replay Lag: ${st.replayLagMb} MB (${st.replayLagBytes} bytes)`);
    }
  }
  lines.push('');

  // Summary
  lines.push('──────────────────────────────────────────────────────────────────────');
  if (report.isReady) {
    lines.push('  ✔ DISASTER RECOVERY READINESS: HEALTHY & READY FOR DDL');
  } else {
    lines.push('  ✖ DISASTER RECOVERY READINESS: COMPROMISED / BLOCKED');
    for (const b of report.blockers) {
      lines.push(`    - BLOCKER: ${b}`);
    }
  }
  for (const w of report.warnings) {
    lines.push(`    - WARNING: ${w}`);
  }
  lines.push('──────────────────────────────────────────────────────────────────────');

  return lines.join('\n');
}


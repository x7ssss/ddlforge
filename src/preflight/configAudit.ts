/**
 * ddlforge - Pre-flight Static Configuration Risk Auditor & Checkpoint Telemetry
 *
 * Audits `pg_settings` for hazardous operational flags and analyzes version-aware
 * checkpoint telemetry to detect write saturation before executing migrations.
 *
 * Architectural Foundations:
 * - High-Risk Settings Rules: Catches `log_statement = 'all'`, `full_page_writes = off`,
 *   `statement_timeout = 0`, `autovacuum = off`, and undersized `maintenance_work_mem`.
 * - Version-Aware Checkpoint Telemetry: Dynamically queries `pg_stat_bgwriter` (PostgreSQL <= 16)
 *   or `pg_stat_checkpointer` (PostgreSQL >= 17) to detect excessive forced checkpoints.
 */

import type { PgClientLike } from '../cluster/advisory.js';

export type ConfigRiskSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

export interface ConfigRiskItem {
  setting: string;
  currentValue: string;
  recommendedValue: string;
  severity: ConfigRiskSeverity;
  ruleId: string;
  message: string;
  impact: string;
  remediation: string;
}

export interface CheckpointHealth {
  pgVersion: number;
  sourceView: 'pg_stat_checkpointer' | 'pg_stat_bgwriter';
  timedCheckpoints: number;
  requestedCheckpoints: number;
  totalCheckpoints: number;
  forcedPercentage: number;
  pressureLevel: 'LOW' | 'MODERATE' | 'HIGH' | 'CRITICAL';
  warning?: string;
  remediation?: string;
}

export interface ConfigAuditReport {
  risks: ConfigRiskItem[];
  checkpointHealth?: CheckpointHealth;
  hasCriticalRisks: boolean;
  hasHighRisks: boolean;
  summary: string;
  passed: boolean;
}

/**
 * Audits a map of PostgreSQL settings against hazardous production migration anti-patterns.
 */
export function auditSettings(settingsMap: Map<string, string> | Record<string, string>): ConfigRiskItem[] {
  const get = (key: string): string => {
    if (settingsMap instanceof Map) {
      return (settingsMap.get(key) || '').toLowerCase().trim();
    }
    return (settingsMap[key] || '').toLowerCase().trim();
  };

  const risks: ConfigRiskItem[] = [];

  // 1. log_statement = 'all'
  const logStatement = get('log_statement');
  if (logStatement === 'all') {
    risks.push({
      setting: 'log_statement',
      currentValue: 'all',
      recommendedValue: 'ddl',
      severity: 'CRITICAL',
      ruleId: 'hazardous-log-statement-all',
      message: 'log_statement is set to "all", logging every single executed query.',
      impact: 'During large keyset backfills or multi-million row DDL migrations, disk I/O will saturate and fill the filesystem with massive write logs, causing server freeze.',
      remediation: 'Set "log_statement = \'ddl\'" or temporary "none" for the migration session.',
    });
  } else if (logStatement === 'mod') {
    risks.push({
      setting: 'log_statement',
      currentValue: 'mod',
      recommendedValue: 'ddl',
      severity: 'MEDIUM',
      ruleId: 'verbose-log-statement-mod',
      message: 'log_statement is set to "mod", logging all data-modifying statements.',
      impact: 'Batch backfills will generate heavy logging overhead.',
      remediation: 'Consider scoping log_statement to "ddl" during migration windows.',
    });
  }

  // 2. full_page_writes = 'off'
  const fullPageWrites = get('full_page_writes');
  if (fullPageWrites === 'off' || fullPageWrites === 'false' || fullPageWrites === '0') {
    risks.push({
      setting: 'full_page_writes',
      currentValue: 'off',
      recommendedValue: 'on',
      severity: 'CRITICAL',
      ruleId: 'hazardous-full-page-writes-off',
      message: 'full_page_writes is disabled.',
      impact: 'If a crash occurs during checkpoint or index building, unrecoverable page corruption (torn pages) can destroy the database cluster.',
      remediation: 'Immediately enable "full_page_writes = on" in postgresql.conf.',
    });
  }

  // 3. statement_timeout = 0
  const statementTimeout = get('statement_timeout');
  if (statementTimeout === '0' || statementTimeout === '0ms' || statementTimeout === '0s') {
    risks.push({
      setting: 'statement_timeout',
      currentValue: '0',
      recommendedValue: '30min',
      severity: 'HIGH',
      ruleId: 'unbounded-statement-timeout',
      message: 'statement_timeout is set to 0 (disabled).',
      impact: 'Long-running migrations or blocked lock acquisitions can hold catalog locks indefinitely, starving live OLTP queries.',
      remediation: 'Set a bounded statement_timeout (e.g. "SET statement_timeout = \'30min\';") before running migrations.',
    });
  }

  // 4. lock_timeout = 0
  const lockTimeout = get('lock_timeout');
  if (lockTimeout === '0' || lockTimeout === '0ms' || lockTimeout === '0s') {
    risks.push({
      setting: 'lock_timeout',
      currentValue: '0',
      recommendedValue: '2s',
      severity: 'HIGH',
      ruleId: 'unbounded-lock-timeout',
      message: 'lock_timeout is set to 0 (disabled).',
      impact: 'Acquiring an AccessExclusiveLock without a lock timeout creates a queue convoy, blocking all subsequent reads and writes on the table.',
      remediation: 'Set bounded lock_timeout (e.g. "SET lock_timeout = \'2s\';") on migration sessions.',
    });
  }

  // 5. autovacuum = 'off'
  const autovacuum = get('autovacuum');
  if (autovacuum === 'off' || autovacuum === 'false' || autovacuum === '0') {
    risks.push({
      setting: 'autovacuum',
      currentValue: 'off',
      recommendedValue: 'on',
      severity: 'HIGH',
      ruleId: 'hazardous-autovacuum-off',
      message: 'autovacuum is globally disabled.',
      impact: 'Table rewrites and backfills will produce massive dead tuple bloat without background cleanup, risking transaction ID wraparound emergency.',
      remediation: 'Enable "autovacuum = on" immediately in postgresql.conf.',
    });
  }

  // 6. maintenance_work_mem < 64MB
  const mwmRaw = get('maintenance_work_mem');
  if (mwmRaw) {
    let mwmBytes = 0;
    if (mwmRaw.endsWith('gb')) {
      mwmBytes = parseFloat(mwmRaw) * 1024 * 1024 * 1024;
    } else if (mwmRaw.endsWith('mb')) {
      mwmBytes = parseFloat(mwmRaw) * 1024 * 1024;
    } else if (mwmRaw.endsWith('kb')) {
      mwmBytes = parseFloat(mwmRaw) * 1024;
    } else {
      // In pg_settings, maintenance_work_mem is typically reported in kB
      const val = parseInt(mwmRaw, 10);
      mwmBytes = val > 1000000 ? val : val * 1024;
    }

    if (mwmBytes > 0 && mwmBytes < 64 * 1024 * 1024) {
      risks.push({
        setting: 'maintenance_work_mem',
        currentValue: mwmRaw,
        recommendedValue: '512MB',
        severity: 'MEDIUM',
        ruleId: 'undersized-maintenance-work-mem',
        message: `maintenance_work_mem (${mwmRaw}) is undersized for large index operations (< 64MB).`,
        impact: 'Index builds will quickly spill to disk in pgsql_tmp, multiplying disk I/O and build duration by 3x-5x.',
        remediation: 'Set "SET maintenance_work_mem = \'512MB\';" or higher for index creation sessions.',
      });
    }
  }

  return risks;
}

/**
 * Evaluates checkpoint telemetry statistics to calculate checkpoint pressure and forced checkpoint ratio.
 */
export function evaluateCheckpointHealth(params: {
  timed: number;
  requested: number;
  pgVersion?: number;
}): CheckpointHealth {
  const pgVersion = params.pgVersion ?? 16;
  const sourceView = pgVersion >= 17 ? 'pg_stat_checkpointer' : 'pg_stat_bgwriter';
  const timed = Math.max(0, params.timed || 0);
  const requested = Math.max(0, params.requested || 0);
  const total = timed + requested;

  const forcedPercentage = total > 0 ? (requested / total) * 100 : 0;

  let pressureLevel: 'LOW' | 'MODERATE' | 'HIGH' | 'CRITICAL' = 'LOW';
  let warning: string | undefined;
  let remediation: string | undefined;

  if (forcedPercentage > 50) {
    pressureLevel = 'CRITICAL';
    warning = `Critical checkpoint pressure: ${forcedPercentage.toFixed(1)}% of all checkpoints are forced (${requested} requested vs ${timed} timed).`;
    remediation = 'max_wal_size is severely undersized for current write volume. Increase max_wal_size and set checkpoint_completion_target = 0.9 before executing heavy migrations.';
  } else if (forcedPercentage > 25) {
    pressureLevel = 'HIGH';
    warning = `High checkpoint pressure: ${forcedPercentage.toFixed(1)}% of checkpoints are forced (${requested} requested vs ${timed} timed).`;
    remediation = 'Increase max_wal_size to prevent frequent forced checkpoints during DDL.';
  } else if (forcedPercentage > 10) {
    pressureLevel = 'MODERATE';
    warning = `Moderate checkpoint pressure: ${forcedPercentage.toFixed(1)}% of checkpoints are forced.`;
  }

  return {
    pgVersion,
    sourceView,
    timedCheckpoints: timed,
    requestedCheckpoints: requested,
    totalCheckpoints: total,
    forcedPercentage,
    pressureLevel,
    warning,
    remediation,
  };
}

/**
 * Runs a complete configuration and checkpoint audit on a live PostgreSQL database.
 */
export async function auditClusterConfig(
  client: PgClientLike,
  options: { pgVersion?: number } = {}
): Promise<ConfigAuditReport> {
  // 1. Detect server version
  let pgVersion = options.pgVersion;
  if (!pgVersion) {
    try {
      const verRes = await client.query("SHOW server_version_num;");
      const verNum = parseInt(verRes.rows[0]?.server_version_num || '160000', 10);
      pgVersion = Math.floor(verNum / 10000);
    } catch {
      pgVersion = 16;
    }
  }

  // 2. Query settings
  const settingsRes = await client.query(`
    SELECT name, setting
    FROM pg_settings
    WHERE name IN (
      'log_statement',
      'full_page_writes',
      'statement_timeout',
      'lock_timeout',
      'autovacuum',
      'maintenance_work_mem',
      'wal_level'
    );
  `);

  const settingsMap = new Map<string, string>();
  for (const row of settingsRes.rows) {
    settingsMap.set(row.name, row.setting);
  }

  const risks = auditSettings(settingsMap);

  // 3. Query checkpoint telemetry with version-aware routing
  let checkpointHealth: CheckpointHealth | undefined;
  try {
    if (pgVersion >= 17) {
      const cpRes = await client.query(`
        SELECT
          COALESCE(num_timed, 0)::bigint AS timed,
          COALESCE(num_requested, 0)::bigint AS requested
        FROM pg_stat_checkpointer;
      `);
      const row = cpRes.rows[0] || {};
      checkpointHealth = evaluateCheckpointHealth({
        timed: Number(row.timed || 0),
        requested: Number(row.requested || 0),
        pgVersion,
      });
    } else {
      const cpRes = await client.query(`
        SELECT
          COALESCE(checkpoints_timed, 0)::bigint AS timed,
          COALESCE(checkpoints_req, 0)::bigint AS requested
        FROM pg_stat_bgwriter;
      `);
      const row = cpRes.rows[0] || {};
      checkpointHealth = evaluateCheckpointHealth({
        timed: Number(row.timed || 0),
        requested: Number(row.requested || 0),
        pgVersion,
      });
    }
  } catch {
    // Checkpoint stats view query failure fallback
  }

  const hasCriticalRisks = risks.some(r => r.severity === 'CRITICAL') || checkpointHealth?.pressureLevel === 'CRITICAL';
  const hasHighRisks = risks.some(r => r.severity === 'HIGH') || checkpointHealth?.pressureLevel === 'HIGH';
  const passed = !hasCriticalRisks;

  const summary = `Config Audit ${passed ? 'PASSED' : 'FAILED'}: Found ${risks.length} issue(s) (${risks.filter(r => r.severity === 'CRITICAL').length} critical, ${risks.filter(r => r.severity === 'HIGH').length} high), Checkpoint pressure: ${checkpointHealth?.pressureLevel || 'UNKNOWN'}.`;

  return {
    risks,
    checkpointHealth,
    hasCriticalRisks,
    hasHighRisks,
    summary,
    passed,
  };
}

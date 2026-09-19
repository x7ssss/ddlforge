/**
 * ddlforge - Autonomous Query Telemetry & Workload Analyzer
 *
 * Mines PostgreSQL internal telemetry from `pg_stat_user_tables` and `pg_stat_statements`
 * without third-party APMs to evaluate write amplification vs read latency:
 * - Read/Write Ratio: (idx_tup_fetch + seq_tup_read) / (n_tup_ins + n_tup_upd + n_tup_del)
 * - HOT (Heap-Only Tuple) Efficiency: (n_tup_hot_upd / n_tup_upd) * 100
 * - Workload Classification: READ_HEAVY, BALANCED, WRITE_LEANING, WRITE_HEAVY
 * - Indexing Guard: Prevents index proliferation on write-heavy or high-HOT tables
 */

import type { PgClientLike } from '../cluster/advisory.js';

export type WorkloadType = 'READ_HEAVY' | 'BALANCED' | 'WRITE_LEANING' | 'WRITE_HEAVY';

export type IndexingRiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';

export interface ReadMetrics {
  idxTupFetch: number;
  seqTupRead: number;
  idxScan: number;
  seqScan: number;
}

export interface WriteMetrics {
  nTupIns: number;
  nTupUpd: number;
  nTupDel: number;
  nHotUpd: number;
}

export interface TableWorkloadProfile {
  schemaName: string;
  tableName: string;
  reads: ReadMetrics;
  writes: WriteMetrics;
  readWriteRatio: number;
  hotEfficiencyPercent: number;
  workloadType: WorkloadType;
  indexingRisk: {
    level: IndexingRiskLevel;
    recommendation: string;
    reason: string;
  };
}

export interface QueryTelemetryProfile {
  queryId: string;
  query: string;
  calls: number;
  totalExecTimeMs: number;
  meanExecTimeMs: number;
  rows: number;
  sharedBlksRead: number;
  sharedBlksHit: number;
  tempBlksWritten: number;
}

export interface WorkloadAnalysisReport {
  tables: TableWorkloadProfile[];
  topSlowQueries: QueryTelemetryProfile[];
  hasPgStatStatements: boolean;
  checkedAt: Date;
}

export interface WorkloadReportOptions {
  schema?: string;
  table?: string;
  limit?: number;
}

/**
 * Calculates Read/Write ratio based on tuple access counts.
 */
export function calculateReadWriteRatio(
  reads: { idxTupFetch: number; seqTupRead: number },
  writes: { nTupIns: number; nTupUpd: number; nTupDel: number }
): number {
  const totalReads = Math.max(0, reads.idxTupFetch) + Math.max(0, reads.seqTupRead);
  const totalWrites = Math.max(0, writes.nTupIns) + Math.max(0, writes.nTupUpd) + Math.max(0, writes.nTupDel);

  if (totalWrites === 0) {
    return totalReads > 0 ? 100 : 1.0;
  }
  const ratio = totalReads / totalWrites;
  return Math.round(ratio * 100) / 100;
}

/**
 * Calculates HOT (Heap-Only Tuple) update efficiency percentage.
 */
export function calculateHotEfficiency(nHotUpd: number, nUpd: number): number {
  const hot = Math.max(0, nHotUpd);
  const total = Math.max(0, nUpd);

  if (total === 0) {
    return 100;
  }
  const pct = (hot / total) * 100;
  return Math.round(pct * 10) / 10;
}

/**
 * Classifies workload type based on Read/Write ratio.
 */
export function classifyWorkload(rwRatio: number): WorkloadType {
  if (rwRatio >= 10.0) return 'READ_HEAVY';
  if (rwRatio >= 3.0) return 'BALANCED';
  if (rwRatio >= 1.0) return 'WRITE_LEANING';
  return 'WRITE_HEAVY';
}

/**
 * Evaluates indexing risk based on Read/Write ratio, HOT efficiency, and sequential scan count.
 */
export function evaluateIndexingRisk(
  rwRatio: number,
  hotEfficiency: number,
  seqScanCount: number
): { level: IndexingRiskLevel; recommendation: string; reason: string } {
  // Risk 1: Write-heavy table (R/W < 1.0)
  if (rwRatio < 1.0) {
    return {
      level: 'HIGH',
      recommendation: 'AVOID_INDEXING_WRITE_HEAVY',
      reason: `Write-heavy table (R/W: ${rwRatio} < 1.0). New indexes will cause severe write amplification and WAL bloat.`,
    };
  }

  // Risk 2: High HOT efficiency table (HOT >= 80%) with non-trivial writes
  if (hotEfficiency >= 80 && rwRatio < 5.0) {
    return {
      level: 'MEDIUM',
      recommendation: 'PRESERVE_HOT_UPDATES',
      reason: `High HOT update efficiency (${hotEfficiency}%). Adding indexes on frequently updated columns will trigger HEAP_UPDATE_ALL_INDEXES cascades.`,
    };
  }

  // Candidate: Significant sequential scans and read-friendly workload
  if (seqScanCount >= 100 && rwRatio >= 2.0) {
    return {
      level: 'LOW',
      recommendation: 'CONSIDER_INDEXING',
      reason: `Table experiences heavy sequential scans (${seqScanCount}) with a healthy read workload (R/W: ${rwRatio}). Good indexing candidate.`,
    };
  }

  return {
    level: 'LOW',
    recommendation: 'MONITOR',
    reason: `Workload is balanced (R/W: ${rwRatio}, HOT: ${hotEfficiency}%). No immediate index adjustments required.`,
  };
}

/**
 * Harvests table workload and tuple statistics from `pg_stat_user_tables`.
 */
export async function harvestTableTelemetry(
  client: PgClientLike,
  options: { schema?: string; table?: string } = {}
): Promise<TableWorkloadProfile[]> {
  const schema = options.schema || 'public';
  let sql = `
    SELECT
      schemaname AS schema_name,
      relname AS table_name,
      COALESCE(seq_scan, 0)::bigint AS seq_scan,
      COALESCE(seq_tup_read, 0)::bigint AS seq_tup_read,
      COALESCE(idx_scan, 0)::bigint AS idx_scan,
      COALESCE(idx_tup_fetch, 0)::bigint AS idx_tup_fetch,
      COALESCE(n_tup_ins, 0)::bigint AS n_tup_ins,
      COALESCE(n_tup_upd, 0)::bigint AS n_tup_upd,
      COALESCE(n_tup_del, 0)::bigint AS n_tup_del,
      COALESCE(n_tup_hot_upd, 0)::bigint AS n_tup_hot_upd
    FROM pg_catalog.pg_stat_user_tables
    WHERE schemaname = $1
  `;
  const params: unknown[] = [schema];

  if (options.table) {
    params.push(options.table);
    sql += ` AND relname = $2`;
  }

  sql += ` ORDER BY (COALESCE(seq_scan, 0) + COALESCE(idx_scan, 0)) DESC;`;

  const res = await client.query(sql, params);
  const profiles: TableWorkloadProfile[] = [];

  for (const row of res.rows || []) {
    const reads: ReadMetrics = {
      idxTupFetch: parseInt(row.idx_tup_fetch, 10) || 0,
      seqTupRead: parseInt(row.seq_tup_read, 10) || 0,
      idxScan: parseInt(row.idx_scan, 10) || 0,
      seqScan: parseInt(row.seq_scan, 10) || 0,
    };
    const writes: WriteMetrics = {
      nTupIns: parseInt(row.n_tup_ins, 10) || 0,
      nTupUpd: parseInt(row.n_tup_upd, 10) || 0,
      nTupDel: parseInt(row.n_tup_del, 10) || 0,
      nHotUpd: parseInt(row.n_tup_hot_upd, 10) || 0,
    };

    const rwRatio = calculateReadWriteRatio(reads, writes);
    const hotEfficiency = calculateHotEfficiency(writes.nHotUpd, writes.nTupUpd);
    const workloadType = classifyWorkload(rwRatio);
    const indexingRisk = evaluateIndexingRisk(rwRatio, hotEfficiency, reads.seqScan);

    profiles.push({
      schemaName: row.schema_name,
      tableName: row.table_name,
      reads,
      writes,
      readWriteRatio: rwRatio,
      hotEfficiencyPercent: hotEfficiency,
      workloadType,
      indexingRisk,
    });
  }

  return profiles;
}

/**
 * Queries `pg_stat_statements` if available to extract top slow or I/O heavy queries.
 */
export async function harvestQueryTelemetry(
  client: PgClientLike,
  options: { limit?: number } = {}
): Promise<{ queries: QueryTelemetryProfile[]; isAvailable: boolean }> {
  const limit = options.limit ?? 10;

  // Check if pg_stat_statements extension exists and view is queryable
  const checkSql = `
    SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements';
  `;
  try {
    const checkRes = await client.query(checkSql);
    if (!checkRes.rows || checkRes.rows.length === 0) {
      return { queries: [], isAvailable: false };
    }
  } catch {
    return { queries: [], isAvailable: false };
  }

  const querySql = `
    SELECT
      queryid::text AS query_id,
      query,
      calls::bigint AS calls,
      total_exec_time AS total_exec_time_ms,
      mean_exec_time AS mean_exec_time_ms,
      rows::bigint AS rows,
      shared_blks_read::bigint AS shared_blks_read,
      shared_blks_hit::bigint AS shared_blks_hit,
      temp_blks_written::bigint AS temp_blks_written
    FROM pg_stat_statements
    WHERE query NOT LIKE '%pg_stat_statements%'
      AND query NOT LIKE '%pg_catalog%'
    ORDER BY total_exec_time DESC
    LIMIT $1;
  `;

  try {
    const res = await client.query(querySql, [limit]);
    const queries: QueryTelemetryProfile[] = (res.rows || []).map(r => ({
      queryId: r.query_id || 'unknown',
      query: (r.query || '').trim(),
      calls: parseInt(r.calls, 10) || 0,
      totalExecTimeMs: Math.round((parseFloat(r.total_exec_time_ms) || 0) * 10) / 10,
      meanExecTimeMs: Math.round((parseFloat(r.mean_exec_time_ms) || 0) * 100) / 100,
      rows: parseInt(r.rows, 10) || 0,
      sharedBlksRead: parseInt(r.shared_blks_read, 10) || 0,
      sharedBlksHit: parseInt(r.shared_blks_hit, 10) || 0,
      tempBlksWritten: parseInt(r.temp_blks_written, 10) || 0,
    }));
    return { queries, isAvailable: true };
  } catch {
    return { queries: [], isAvailable: false };
  }
}

/**
 * Harvests complete workload analysis report.
 */
export async function harvestFullWorkloadReport(
  client: PgClientLike,
  options: WorkloadReportOptions = {}
): Promise<WorkloadAnalysisReport> {
  const tables = await harvestTableTelemetry(client, {
    schema: options.schema,
    table: options.table,
  });
  const { queries: topSlowQueries, isAvailable: hasPgStatStatements } = await harvestQueryTelemetry(client, {
    limit: options.limit ?? 10,
  });

  return {
    tables,
    topSlowQueries,
    hasPgStatStatements,
    checkedAt: new Date(),
  };
}

/**
 * Formats workload telemetry report into a colorized, human-readable terminal output.
 */
export function formatWorkloadReportTerminal(report: WorkloadAnalysisReport): string {
  const lines: string[] = [];

  lines.push('');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('  ddlforge v1.9.0 — Autonomous Query Telemetry & Workload Analyzer');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push(`Checked At:             ${report.checkedAt.toISOString()}`);
  lines.push(`Monitored Tables:       ${report.tables.length}`);
  lines.push(`pg_stat_statements:     ${report.hasPgStatStatements ? 'ACTIVE' : 'NOT INSTALLED'}`);
  lines.push('');

  if (report.tables.length === 0) {
    lines.push('  No tables found in specified schema.');
    return lines.join('\n');
  }

  lines.push('TABLE WORKLOAD PROFILES:');
  lines.push('──────────────────────────────────────────────────────────────────────');

  for (const t of report.tables) {
    const badge = `[${t.workloadType}]`;
    const riskBadge = `[RISK: ${t.indexingRisk.level}]`;
    lines.push(`┌── Table: "${t.schemaName}"."${t.tableName}" ${badge} ${riskBadge} ─────────────`);
    lines.push(`│   R/W Ratio:       ${t.readWriteRatio} (Reads: ${t.reads.idxTupFetch + t.reads.seqTupRead}, Writes: ${t.writes.nTupIns + t.writes.nTupUpd + t.writes.nTupDel})`);
    lines.push(`│   HOT Efficiency:  ${t.hotEfficiencyPercent}% (HOT updates: ${t.writes.nHotUpd} / ${t.writes.nTupUpd})`);
    lines.push(`│   Access Pattern:  Seq Scans: ${t.reads.seqScan} (${t.reads.seqTupRead} rows) | Index Scans: ${t.reads.idxScan} (${t.reads.idxTupFetch} rows)`);
    lines.push(`│   Recommendation:  ${t.indexingRisk.recommendation}`);
    lines.push(`│   Reason:          ${t.indexingRisk.reason}`);
    lines.push(`└─────────────────────────────────────────────────────────────────────`);
    lines.push('');
  }

  if (report.topSlowQueries.length > 0) {
    lines.push('TOP SLOW / I/O-HEAVY QUERIES (pg_stat_statements):');
    lines.push('──────────────────────────────────────────────────────────────────────');
    for (const q of report.topSlowQueries) {
      const summary = q.query.length > 80 ? q.query.slice(0, 80) + '...' : q.query;
      lines.push(`• Query ID: ${q.queryId} (${q.calls} calls, total: ${q.totalExecTimeMs}ms, avg: ${q.meanExecTimeMs}ms)`);
      lines.push(`  SQL:      ${summary}`);
      lines.push(`  Shared Blocks: Read ${q.sharedBlksRead}, Hit ${q.sharedBlksHit} | Temp Blocks Written: ${q.tempBlksWritten}`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

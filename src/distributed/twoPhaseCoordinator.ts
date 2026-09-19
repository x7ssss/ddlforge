/**
 * ddlforge - Distributed DDL State Machine & Two-Phase Coordinator
 *
 * Implements an application-level Distributed Transaction Coordinator utilizing a durable
 * state ledger table (`ddlforge.ddlforge_distributed_run`).
 *
 * Invariant: PostgreSQL restricts DDL statements inside native `PREPARE TRANSACTION` blocks
 * (SQLSTATE 0A000), and `CONCURRENTLY` modifiers prohibit transactions altogether.
 * This coordinator manages durable distributed intent logging, consensus evaluation,
 * and automated orphan sweeping across distributed multi-tenant fleets.
 */

import { createHash, randomUUID } from 'node:crypto';
import type { PgClientLike } from '../cluster/advisory.js';

export type DistributedPhase = 'PREPARED' | 'COMMITTED' | 'ABORTED' | 'HEALED';

export interface DistributedRunRecord {
  runId: string;
  migrationVersion: string;
  nodeId: string;
  phase: DistributedPhase;
  preparedAt: Date;
  committedAt?: Date | null;
  gid?: string | null;
  ddlStatement: string;
  checksum: string;
  retryCount: number;
  lastError?: string | null;
  metadata?: Record<string, any>;
}

export interface PrepareRunOptions {
  runId: string;
  migrationVersion: string;
  nodeId: string;
  ddlStatement: string;
  gid?: string;
  metadata?: Record<string, any>;
}

export interface CommitRunOptions {
  runId: string;
  nodeId: string;
  metadata?: Record<string, any>;
}

export interface AbortRunOptions {
  runId: string;
  nodeId: string;
  error: string;
}

export interface SweepOptions {
  maxAgeMinutes?: number; // Default: 30
  autoHeal?: boolean; // Default: true
  dryRun?: boolean; // Default: false
}

export interface OrphanSweepAction {
  runId: string;
  nodeId: string;
  migrationVersion: string;
  fromPhase: DistributedPhase;
  toPhase: DistributedPhase;
  reason: string;
}

export interface OrphanSweepReport {
  inspectedRuns: number;
  staleCount: number;
  healedCount: number;
  abortedCount: number;
  actions: OrphanSweepAction[];
  checkedAt: Date;
}

/**
 * Normalizes SQL statement by stripping leading/trailing whitespace and comments
 * to ensure deterministic SHA-256 checksums across distributed nodes.
 */
export function normalizeDdl(sql: string): string {
  return sql
    .replace(/--.*$/gm, '') // Strip line comments
    .replace(/\/\*[\s\S]*?\*\//g, '') // Strip block comments
    .trim()
    .replace(/\s+/g, ' '); // Collapse whitespaces
}

/**
 * Computes deterministic SHA-256 checksum of normalized DDL statement.
 */
export function calculateDdlChecksum(sql: string): string {
  const normalized = normalizeDdl(sql);
  return createHash('sha256').update(normalized, 'utf-8').digest('hex');
}

/**
 * Emits idempotent DDL to create the distributed state ledger table.
 */
export function getBootstrapLedgerSql(): string {
  return `
    CREATE SCHEMA IF NOT EXISTS ddlforge;

    CREATE TABLE IF NOT EXISTS ddlforge.ddlforge_distributed_run (
      run_id VARCHAR(64) NOT NULL,
      migration_version VARCHAR(64) NOT NULL,
      node_id VARCHAR(128) NOT NULL,
      phase VARCHAR(16) NOT NULL, -- 'PREPARED', 'COMMITTED', 'ABORTED', 'HEALED'
      prepared_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      committed_at TIMESTAMPTZ,
      gid VARCHAR(128),
      ddl_statement TEXT NOT NULL,
      checksum VARCHAR(64) NOT NULL,
      retry_count INT NOT NULL DEFAULT 0,
      last_error TEXT,
      metadata JSONB,
      PRIMARY KEY (run_id, node_id)
    );

    CREATE INDEX IF NOT EXISTS idx_ddlforge_dist_phase_prep
      ON ddlforge.ddlforge_distributed_run (phase, prepared_at);
  `;
}

/**
 * Ensures the distributed ledger table exists on the target database.
 */
export async function ensureLedgerExists(client: PgClientLike): Promise<void> {
  await client.query(getBootstrapLedgerSql());
}

/**
 * Phase 1: Records distributed intent ('PREPARED') in the state ledger table.
 */
export async function prepareDistributedRun(
  client: PgClientLike,
  options: PrepareRunOptions
): Promise<DistributedRunRecord> {
  await ensureLedgerExists(client);

  const checksum = calculateDdlChecksum(options.ddlStatement);
  const now = new Date();
  const gid = options.gid || `ddlforge_gid_${options.runId}_${options.nodeId}`;

  const sql = `
    INSERT INTO ddlforge.ddlforge_distributed_run (
      run_id, migration_version, node_id, phase, prepared_at,
      gid, ddl_statement, checksum, retry_count, metadata
    )
    VALUES ($1, $2, $3, 'PREPARED', $4, $5, $6, $7, 0, $8)
    ON CONFLICT (run_id, node_id) DO UPDATE SET
      phase = 'PREPARED',
      prepared_at = EXCLUDED.prepared_at,
      ddl_statement = EXCLUDED.ddl_statement,
      checksum = EXCLUDED.checksum,
      metadata = EXCLUDED.metadata;
  `;

  await client.query(sql, [
    options.runId,
    options.migrationVersion,
    options.nodeId,
    now.toISOString(),
    gid,
    options.ddlStatement,
    checksum,
    JSON.stringify(options.metadata || {}),
  ]);

  return {
    runId: options.runId,
    migrationVersion: options.migrationVersion,
    nodeId: options.nodeId,
    phase: 'PREPARED',
    preparedAt: now,
    committedAt: null,
    gid,
    ddlStatement: options.ddlStatement,
    checksum,
    retryCount: 0,
    metadata: options.metadata,
  };
}

/**
 * Phase 2 (Commit): Marks distributed run as 'COMMITTED' in state ledger.
 */
export async function commitDistributedRun(
  client: PgClientLike,
  options: CommitRunOptions
): Promise<void> {
  const sql = `
    UPDATE ddlforge.ddlforge_distributed_run
    SET phase = 'COMMITTED',
        committed_at = clock_timestamp(),
        metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb
    WHERE run_id = $1 AND node_id = $2;
  `;

  await client.query(sql, [
    options.runId,
    options.nodeId,
    JSON.stringify(options.metadata || {}),
  ]);
}

/**
 * Phase 2 (Abort): Marks distributed run as 'ABORTED' in state ledger with error details.
 */
export async function abortDistributedRun(
  client: PgClientLike,
  options: AbortRunOptions
): Promise<void> {
  const sql = `
    UPDATE ddlforge.ddlforge_distributed_run
    SET phase = 'ABORTED',
        last_error = $3,
        retry_count = retry_count + 1
    WHERE run_id = $1 AND node_id = $2;
  `;

  await client.query(sql, [options.runId, options.nodeId, options.error]);
}

/**
 * Self-Healing Orphan Sweeper: Queries abandoned PREPARED runs older than `--max-age-minutes`
 * and applies consensus resolution across nodes.
 */
export async function sweepDistributedRuns(
  client: PgClientLike,
  options: SweepOptions = {}
): Promise<OrphanSweepReport> {
  await ensureLedgerExists(client);

  const maxAgeMinutes = options.maxAgeMinutes ?? 30;
  const autoHeal = options.autoHeal ?? true;
  const dryRun = options.dryRun ?? false;
  const checkedAt = new Date();

  // 1. Find all stale PREPARED records older than maxAgeMinutes
  const staleSql = `
    SELECT
      run_id, migration_version, node_id, phase, prepared_at,
      gid, ddl_statement, checksum, retry_count, last_error
    FROM ddlforge.ddlforge_distributed_run
    WHERE phase = 'PREPARED'
      AND prepared_at < NOW() - ($1 || ' minutes')::interval
    ORDER BY prepared_at ASC;
  `;

  const staleRes = await client.query(staleSql, [maxAgeMinutes.toString()]);
  const staleRows = staleRes.rows || [];

  const actions: OrphanSweepAction[] = [];
  let healedCount = 0;
  let abortedCount = 0;

  // 2. Evaluate consensus per run_id
  const runIds = Array.from(new Set(staleRows.map(r => r.run_id as string)));

  for (const runId of runIds) {
    // Query all records for this run_id across the fleet to evaluate consensus
    const fleetSql = `
      SELECT node_id, phase
      FROM ddlforge.ddlforge_distributed_run
      WHERE run_id = $1;
    `;
    const fleetRes = await client.query(fleetSql, [runId]);
    const fleetRows = fleetRes.rows || [];

    const totalNodes = fleetRows.length;
    const committedCount = fleetRows.filter(r => r.phase === 'COMMITTED').length;
    const isMajorityCommitted = committedCount > Math.floor(totalNodes / 2);

    const affectedStaleNodes = staleRows.filter(r => r.run_id === runId);

    for (const node of affectedStaleNodes) {
      if (isMajorityCommitted && autoHeal) {
        // Majority of nodes successfully committed; heal the lagging node
        const action: OrphanSweepAction = {
          runId,
          nodeId: node.node_id,
          migrationVersion: node.migration_version,
          fromPhase: 'PREPARED',
          toPhase: 'HEALED',
          reason: `Fleet consensus achieved: ${committedCount}/${totalNodes} nodes committed. Marked HEALED.`,
        };
        actions.push(action);
        healedCount++;

        if (!dryRun) {
          await client.query(`
            UPDATE ddlforge.ddlforge_distributed_run
            SET phase = 'HEALED',
                committed_at = clock_timestamp(),
                last_error = 'Auto-healed by orphan sweeper based on majority fleet consensus'
            WHERE run_id = $1 AND node_id = $2;
          `, [runId, node.node_id]);
        }
      } else {
        // Consensus not met or run completely abandoned; abort node
        const action: OrphanSweepAction = {
          runId,
          nodeId: node.node_id,
          migrationVersion: node.migration_version,
          fromPhase: 'PREPARED',
          toPhase: 'ABORTED',
          reason: `Fleet consensus failed: only ${committedCount}/${totalNodes} nodes committed after ${maxAgeMinutes}m. Marked ABORTED.`,
        };
        actions.push(action);
        abortedCount++;

        if (!dryRun) {
          await client.query(`
            UPDATE ddlforge.ddlforge_distributed_run
            SET phase = 'ABORTED',
                last_error = 'Aborted by orphan sweeper: age exceeded threshold without majority consensus'
            WHERE run_id = $1 AND node_id = $2;
          `, [runId, node.node_id]);
        }
      }
    }
  }

  return {
    inspectedRuns: staleRows.length,
    staleCount: staleRows.length,
    healedCount,
    abortedCount,
    actions,
    checkedAt,
  };
}

/**
 * Formats orphan sweep report into human-readable terminal output.
 */
export function formatSweepReportTerminal(report: OrphanSweepReport): string {
  const lines: string[] = [];

  lines.push('');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('  ddlforge v1.8.0 — Distributed DDL Orphan Sweeper Report');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push(`Checked At:          ${report.checkedAt.toISOString()}`);
  lines.push(`Stale Runs Detected: ${report.staleCount}`);
  lines.push(`Auto-Healed Runs:    ${report.healedCount}`);
  lines.push(`Aborted Runs:        ${report.abortedCount}`);
  lines.push('');

  if (report.actions.length === 0) {
    lines.push('  ✔ All distributed runs are healthy. No orphaned PREPARED runs detected.');
    lines.push('');
    return lines.join('\n');
  }

  lines.push('RUN ID                  NODE ID            TRANSITION           REASON');
  lines.push('───────────────────────────────────────────────────────────────────────────────────');

  for (const act of report.actions) {
    const runCol = act.runId.padEnd(23).slice(0, 23);
    const nodeCol = act.nodeId.padEnd(18).slice(0, 18);
    const transCol = `${act.fromPhase} -> ${act.toPhase}`.padEnd(20).slice(0, 20);
    lines.push(`${runCol} ${nodeCol} ${transCol} ${act.reason}`);
  }

  lines.push('');
  return lines.join('\n');
}

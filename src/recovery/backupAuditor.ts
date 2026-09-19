/**
 * ddlforge - Backup Recency Auditor & RPO Compliance Engine
 *
 * Verifies that a valid, fresh physical or logical backup exists within the
 * Recovery Point Objective (RPO) threshold (default: 24h) prior to executing
 * high-risk schema migrations.
 *
 * Supported Backup Verification Providers:
 * - `catalog`: Inspects `ddlforge.backup_catalog` for latest completed backup.
 * - `pgbackrest`: Parses `pgbackrest info --output=json` manifests.
 * - `mock` / `manual`: For testing and dry-run simulations.
 */

import { execSync } from 'node:child_process';
import type { PgClientLike } from '../cluster/advisory.js';

export type BackupProvider = 'catalog' | 'pgbackrest' | 'mock' | 'manual';

export interface BackupRecord {
  backupId: string;
  provider: BackupProvider | string;
  backupType: 'full' | 'diff' | 'incr' | string;
  status: 'completed' | 'failed' | 'running';
  startedAt: Date;
  completedAt: Date | null;
  sizeBytes?: bigint | number;
  lsnStop?: string | null;
  ageHours: number;
  metadata?: Record<string, any>;
}

export interface BackupAuditorOptions {
  provider?: BackupProvider;
  rpoHours?: number; // default: 24 hours
  forceNoBackup?: boolean;
  now?: Date;
  catalogTableName?: string;
  // pgbackrest options
  pgbackrestBin?: string;
  pgbackrestStanza?: string;
  pgbackrestJson?: string | object;
  // mock options
  mockAgeHours?: number;
  mockBackupRecord?: Partial<BackupRecord>;
}

export interface BackupAuditorReport {
  provider: BackupProvider | string;
  rpoHours: number;
  latestBackup: BackupRecord | null;
  isCompliant: boolean;
  actualAgeHours: number | null;
  violationReason?: string;
  checkedAt: Date;
}

/**
 * Error thrown when latest backup exceeds the RPO compliance threshold.
 */
export class RpoViolationError extends Error {
  readonly rpoHours: number;
  readonly actualAgeHours: number | null;
  readonly lastBackup: BackupRecord | null;
  readonly provider: string;

  constructor(
    message: string,
    details: {
      rpoHours: number;
      actualAgeHours: number | null;
      lastBackup?: BackupRecord | null;
      provider: string;
    }
  ) {
    super(message);
    this.name = 'RpoViolationError';
    this.rpoHours = details.rpoHours;
    this.actualAgeHours = details.actualAgeHours;
    this.lastBackup = details.lastBackup ?? null;
    this.provider = details.provider;
  }
}

/**
 * Detects whether a migration SQL string contains destructive, irreversible,
 * or high-risk operations requiring fresh backup verification.
 */
export function detectHighRiskOperations(sql: string): { isHighRisk: boolean; reasons: string[] } {
  const reasons: string[] = [];

  // 1. DROP TABLE
  if (/\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([^\s;]+)/i.test(sql)) {
    reasons.push('DROP TABLE statement detected');
  }

  // 2. DROP COLUMN
  if (/\bALTER\s+TABLE\s+.*?\bDROP\s+(?:COLUMN\s+)?([^\s;,]+)/is.test(sql)) {
    reasons.push('DROP COLUMN statement detected');
  }

  // 3. ALTER TABLE ... ALTER COLUMN ... TYPE (table rewrite / data truncation)
  if (/\bALTER\s+TABLE\s+.*?\b(?:ALTER\s+(?:COLUMN\s+)?\w+\s+(?:SET\s+DATA\s+)?TYPE)\b/is.test(sql)) {
    reasons.push('Column TYPE rewrite detected');
  }

  // 4. TRUNCATE TABLE
  if (/\bTRUNCATE\s+(?:TABLE\s+)?/i.test(sql)) {
    reasons.push('TRUNCATE statement detected');
  }

  // 5. Partition detach / drop
  if (/\bALTER\s+TABLE\s+.*?\bDETACH\s+PARTITION\b/is.test(sql)) {
    reasons.push('DETACH PARTITION statement detected');
  }

  return {
    isHighRisk: reasons.length > 0,
    reasons,
  };
}

/**
 * Parses JSON output from `pgbackrest info --output=json` and extracts the latest completed backup.
 */
export function parsePgBackRestJson(
  jsonInput: string | object,
  now: Date = new Date()
): BackupRecord | null {
  let parsed: any;
  if (typeof jsonInput === 'string') {
    try {
      parsed = JSON.parse(jsonInput);
    } catch (err: any) {
      throw new Error(`parsePgBackRestJson: Failed to parse JSON manifest: ${err.message}`);
    }
  } else {
    parsed = jsonInput;
  }

  if (!parsed) return null;

  // Stanzas can be returned as an array or a single object
  const stanzas: any[] = Array.isArray(parsed) ? parsed : [parsed];

  let latestCandidate: BackupRecord | null = null;
  let maxStopTime = 0;

  for (const stanza of stanzas) {
    if (!stanza || !Array.isArray(stanza.backup)) continue;

    for (const bk of stanza.backup) {
      // Ignore backups marked with error
      if (bk.error === true) continue;

      const stopRaw = bk.timestamp?.stop;
      if (!stopRaw) continue;

      // Handle seconds vs milliseconds (Unix timestamp in seconds is < 1e11)
      const stopMs = stopRaw < 1e11 ? stopRaw * 1000 : stopRaw;
      const startRaw = bk.timestamp?.start;
      const startMs = startRaw ? (startRaw < 1e11 ? startRaw * 1000 : startRaw) : stopMs;

      if (stopMs > maxStopTime) {
        maxStopTime = stopMs;
        const completedAt = new Date(stopMs);
        const startedAt = new Date(startMs);
        const ageHours = (now.getTime() - completedAt.getTime()) / (3600 * 1000);

        let sizeBytes: bigint | undefined;
        if (bk.info?.size !== undefined) {
          sizeBytes = BigInt(bk.info.size);
        }

        latestCandidate = {
          backupId: bk.label || String(stopRaw),
          provider: 'pgbackrest',
          backupType: bk.type || 'full',
          status: 'completed',
          startedAt,
          completedAt,
          sizeBytes,
          lsnStop: bk.lsn?.stop ? String(bk.lsn.stop) : null,
          ageHours: Math.max(0, ageHours),
          metadata: {
            stanza: stanza.name,
            deltaBytes: bk.info?.delta,
            lsnStart: bk.lsn?.start,
          },
        };
      }
    }
  }

  return latestCandidate;
}

/**
 * Ensures the `ddlforge.backup_catalog` table exists in PostgreSQL.
 */
export async function ensureBackupCatalogTable(client: PgClientLike): Promise<void> {
  const ddl = `
    CREATE SCHEMA IF NOT EXISTS ddlforge;
    CREATE TABLE IF NOT EXISTS ddlforge.backup_catalog (
      id SERIAL PRIMARY KEY,
      backup_id VARCHAR(255) NOT NULL,
      provider VARCHAR(64) NOT NULL,
      backup_type VARCHAR(64) NOT NULL,
      status VARCHAR(32) NOT NULL,
      started_at TIMESTAMPTZ NOT NULL,
      completed_at TIMESTAMPTZ,
      size_bytes BIGINT,
      lsn_stop VARCHAR(64),
      metadata JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_ddlforge_backup_catalog_completed
      ON ddlforge.backup_catalog (status, completed_at DESC);
  `;

  await client.query(ddl);
}

/**
 * Records a completed or attempted backup in `ddlforge.backup_catalog`.
 */
export async function recordCatalogBackup(
  client: PgClientLike,
  record: Omit<BackupRecord, 'ageHours'>
): Promise<void> {
  await ensureBackupCatalogTable(client);

  const sql = `
    INSERT INTO ddlforge.backup_catalog (
      backup_id, provider, backup_type, status, started_at, completed_at, size_bytes, lsn_stop, metadata
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb);
  `;

  await client.query(sql, [
    record.backupId,
    record.provider,
    record.backupType,
    record.status,
    record.startedAt.toISOString(),
    record.completedAt ? record.completedAt.toISOString() : null,
    record.sizeBytes !== undefined ? record.sizeBytes.toString() : null,
    record.lsnStop ?? null,
    JSON.stringify(record.metadata ?? {}),
  ]);
}

/**
 * Queries `ddlforge.backup_catalog` for the most recent completed backup.
 */
export async function queryCatalogBackup(
  client: PgClientLike,
  now: Date = new Date(),
  tableName: string = 'ddlforge.backup_catalog'
): Promise<BackupRecord | null> {
  try {
    const sql = `
      SELECT
        backup_id,
        provider,
        backup_type,
        status,
        started_at,
        completed_at,
        size_bytes::text AS size_bytes,
        lsn_stop,
        metadata
      FROM ${tableName}
      WHERE status = 'completed' AND completed_at IS NOT NULL
      ORDER BY completed_at DESC
      LIMIT 1;
    `;

    const res = await client.query(sql);
    const row = res.rows[0];
    if (!row) return null;

    const completedAt = new Date(row.completed_at);
    const startedAt = new Date(row.started_at);
    const ageHours = (now.getTime() - completedAt.getTime()) / (3600 * 1000);

    return {
      backupId: row.backup_id,
      provider: row.provider || 'catalog',
      backupType: row.backup_type || 'full',
      status: 'completed',
      startedAt,
      completedAt,
      sizeBytes: row.size_bytes ? BigInt(row.size_bytes) : undefined,
      lsnStop: row.lsn_stop ?? null,
      ageHours: Math.max(0, ageHours),
      metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata,
    };
  } catch (err: any) {
    // If table doesn't exist, return null gracefully
    return null;
  }
}

/**
 * Audits backup recency against RPO threshold across supported providers.
 */
export async function auditBackupRpo(
  provider: BackupProvider,
  clientOrOptions?: PgClientLike | BackupAuditorOptions,
  maybeOptions?: BackupAuditorOptions
): Promise<BackupAuditorReport> {
  let client: PgClientLike | undefined;
  let options: BackupAuditorOptions;

  if (clientOrOptions && 'query' in clientOrOptions) {
    client = clientOrOptions as PgClientLike;
    options = maybeOptions ?? {};
  } else {
    options = (clientOrOptions as BackupAuditorOptions) ?? {};
  }

  const rpoHours = options.rpoHours ?? 24;
  const now = options.now ?? new Date();

  let latestBackup: BackupRecord | null = null;

  switch (provider) {
    case 'catalog': {
      if (!client) {
        throw new Error('auditBackupRpo: "catalog" provider requires an active PostgreSQL client.');
      }
      latestBackup = await queryCatalogBackup(
        client,
        now,
        options.catalogTableName ?? 'ddlforge.backup_catalog'
      );
      break;
    }

    case 'pgbackrest': {
      if (options.pgbackrestJson) {
        latestBackup = parsePgBackRestJson(options.pgbackrestJson, now);
      } else {
        const bin = options.pgbackrestBin ?? 'pgbackrest';
        const stanzaArg = options.pgbackrestStanza ? ` --stanza=${options.pgbackrestStanza}` : '';
        try {
          const stdout = execSync(`${bin} info --output=json${stanzaArg}`, {
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'ignore'],
          });
          latestBackup = parsePgBackRestJson(stdout, now);
        } catch (err: any) {
          return {
            provider: 'pgbackrest',
            rpoHours,
            latestBackup: null,
            isCompliant: false,
            actualAgeHours: null,
            violationReason: `Failed to execute pgbackrest: ${err.message}`,
            checkedAt: now,
          };
        }
      }
      break;
    }

    case 'mock':
    case 'manual': {
      if (options.mockBackupRecord) {
        const completedAt =
          options.mockBackupRecord.completedAt ??
          new Date(now.getTime() - (options.mockAgeHours ?? 2) * 3600 * 1000);
        const ageHours =
          options.mockAgeHours ?? (now.getTime() - completedAt.getTime()) / (3600 * 1000);

        latestBackup = {
          backupId: options.mockBackupRecord.backupId ?? 'mock-backup-001',
          provider: 'mock',
          backupType: options.mockBackupRecord.backupType ?? 'full',
          status: options.mockBackupRecord.status ?? 'completed',
          startedAt: options.mockBackupRecord.startedAt ?? new Date(completedAt.getTime() - 1800000),
          completedAt,
          sizeBytes: options.mockBackupRecord.sizeBytes ?? 1073741824n,
          lsnStop: options.mockBackupRecord.lsnStop ?? '0/16B3748',
          ageHours: Math.max(0, ageHours),
          metadata: options.mockBackupRecord.metadata,
        };
      } else if (options.mockAgeHours !== undefined) {
        const completedAt = new Date(now.getTime() - options.mockAgeHours * 3600 * 1000);
        latestBackup = {
          backupId: 'mock-auto',
          provider: 'mock',
          backupType: 'full',
          status: 'completed',
          startedAt: new Date(completedAt.getTime() - 1800000),
          completedAt,
          sizeBytes: 104857600n,
          lsnStop: '0/1000000',
          ageHours: options.mockAgeHours,
        };
      }
      break;
    }
  }

  if (!latestBackup || latestBackup.status !== 'completed' || !latestBackup.completedAt) {
    return {
      provider,
      rpoHours,
      latestBackup: null,
      isCompliant: false,
      actualAgeHours: null,
      violationReason: `No valid completed backup found under provider "${provider}".`,
      checkedAt: now,
    };
  }

  const actualAgeHours = latestBackup.ageHours;
  const isCompliant = actualAgeHours <= rpoHours;

  let violationReason: string | undefined;
  if (!isCompliant) {
    violationReason = `Latest backup "${latestBackup.backupId}" completed ${actualAgeHours.toFixed(1)}h ago, exceeding RPO limit of ${rpoHours}h.`;
  }

  return {
    provider,
    rpoHours,
    latestBackup,
    isCompliant,
    actualAgeHours,
    violationReason,
    checkedAt: now,
  };
}

/**
 * Asserts RPO compliance and throws RpoViolationError if violated and forceNoBackup is false.
 */
export function assertRpoCompliance(
  report: BackupAuditorReport,
  forceNoBackup: boolean = false
): void {
  if (!report.isCompliant && !forceNoBackup) {
    throw new RpoViolationError(
      report.violationReason ?? `Backup violates RPO limit of ${report.rpoHours}h.`,
      {
        rpoHours: report.rpoHours,
        actualAgeHours: report.actualAgeHours,
        lastBackup: report.latestBackup,
        provider: String(report.provider),
      }
    );
  }
}

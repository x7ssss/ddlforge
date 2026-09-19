/**
 * ddlforge - Pre-flight Disk & Mount Guard Engine
 *
 * Implements mathematical footprint estimation for index creations and table rewrites,
 * storage topology analysis (shared-mount detection), and OS disk headroom validation.
 *
 * Architectural Foundations:
 * - Storage & Mount Topology: Proactive detection of shared-mount anti-patterns where
 *   `pg_wal` and `data_directory` share the same filesystem partition.
 * - Mathematical Footprint Estimation:
 *   - CREATE INDEX CONCURRENTLY: 1.5x-2x index size factoring in maintenance_work_mem
 *     spills and safe tuple ceilings (max(reltuples, n_live_tup + n_dead_tup)).
 *   - Table Rewrites: 2x heap + TOAST size validation + rebuilt index footprint + WAL overhead.
 * - OS Disk Headroom Assertion: Ensures remaining capacity stays above safe operational margins.
 */

import * as path from 'node:path';
import type { PgClientLike } from '../cluster/advisory.js';

export interface IndexSpaceEstimateParams {
  reltuples: number;
  nLiveTup?: number;
  nDeadTup?: number;
  tableBytes?: number;
  maintenanceWorkMemBytes?: number; // default: 64MB (67108864)
  avgIndexTupleBytes?: number; // default: 32 bytes
  safetyMultiplier?: number; // default: 1.75 (between 1.5 and 2.0)
}

export interface IndexSpaceEstimate {
  reltuples: number;
  nLiveTup: number;
  nDeadTup: number;
  effectiveTuples: number;
  estimatedIndexBytes: number;
  tempSortBytes: number;
  walBytes: number;
  totalRequiredBytes: number;
  spillsToDisk: boolean;
  safetyMultiplier: number;
}

export interface TableRewriteEstimateParams {
  heapBytes: number;
  toastBytes?: number;
  indexesBytes?: number;
  safetyMultiplier?: number; // default: 2.0
}

export interface TableRewriteEstimate {
  heapBytes: number;
  toastBytes: number;
  indexesBytes: number;
  transientTableBytes: number; // 2x (heap + toast)
  rebuiltIndexesBytes: number;
  walBytes: number;
  totalRequiredBytes: number;
  safetyMultiplier: number;
}

export interface SharedMountAnalysis {
  dataDirectory: string;
  walDirectory: string;
  isSharedMount: boolean;
  risk: 'CRITICAL' | 'HIGH' | 'LOW';
  warning?: string;
  remediation?: string;
}

export interface DiskHeadroomReport {
  availableBytes: number;
  requiredBytes: number;
  safetyMultiplier: number;
  hasSufficientSpace: boolean;
  projectedRemainingBytes: number;
  projectedRemainingPercent: number;
  status: 'SAFE' | 'WARNING' | 'CRITICAL';
  warning?: string;
}

export interface DiskGuardOptions {
  schema?: string; // default: 'public'
  operation?: 'create_index' | 'table_rewrite' | 'auto';
  safetyMultiplier?: number;
  availableBytes?: number;
  maintenanceWorkMemBytes?: number;
  avgIndexTupleBytes?: number;
}

export interface DiskGuardReport {
  table: string;
  schema: string;
  operation: 'create_index' | 'table_rewrite';
  sharedMount: SharedMountAnalysis;
  indexEstimate?: IndexSpaceEstimate;
  rewriteEstimate?: TableRewriteEstimate;
  headroom: DiskHeadroomReport;
  summary: string;
  passed: boolean;
}

/**
 * Computes estimated temporary space requirements for CREATE INDEX / CREATE INDEX CONCURRENTLY.
 *
 * Formula:
 * - Safe tuple ceiling: max(reltuples, n_live_tup + n_dead_tup)
 * - Base index footprint: (effectiveTuples * avgTupleBytes) / 0.9 (leaf page fillfactor)
 * - Sort memory spills: if sort volume exceeds maintenance_work_mem, temp files in pgsql_tmp
 * - WAL generation: full page writes & WAL stream during concurrent build
 * - Total required: (estimatedIndexBytes * safetyMultiplier) + tempSortBytes + walBytes
 */
export function estimateIndexSpace(params: IndexSpaceEstimateParams): IndexSpaceEstimate {
  const reltuples = Math.max(0, Math.floor(params.reltuples || 0));
  const nLiveTup = Math.max(0, Math.floor(params.nLiveTup || 0));
  const nDeadTup = Math.max(0, Math.floor(params.nDeadTup || 0));

  // Safe tuple ceiling: accounts for autovacuum lag where reltuples might be stale
  const effectiveTuples = Math.max(reltuples, nLiveTup + nDeadTup);

  const avgTupleBytes = params.avgIndexTupleBytes ?? 32;
  const maintenanceWorkMem = params.maintenanceWorkMemBytes ?? 64 * 1024 * 1024; // 64 MB
  const rawMultiplier = params.safetyMultiplier ?? 1.75;
  const safetyMultiplier = Math.min(2.0, Math.max(1.5, rawMultiplier));

  // Base B-tree index size (factoring default 90% fillfactor and page headers)
  const estimatedIndexBytes = effectiveTuples > 0
    ? Math.ceil((effectiveTuples * avgTupleBytes) / 0.9)
    : 16384; // Minimum 2 pages (16KB)

  // Sort volume needed during index build
  const rawSortBytes = effectiveTuples * avgTupleBytes;
  const spillsToDisk = rawSortBytes > maintenanceWorkMem;
  // If sort spills to disk, temporary merge runs require ~1.2x sort data in pgsql_tmp
  const tempSortBytes = spillsToDisk ? Math.ceil(rawSortBytes * 1.2) : 0;

  // WAL generation during index build (typically 1.1x - 1.2x index size in replica/logical wal_level)
  const walBytes = Math.ceil(estimatedIndexBytes * 1.2);

  // Total required disk capacity
  const totalRequiredBytes = Math.ceil(estimatedIndexBytes * safetyMultiplier + tempSortBytes + walBytes);

  return {
    reltuples,
    nLiveTup,
    nDeadTup,
    effectiveTuples,
    estimatedIndexBytes,
    tempSortBytes,
    walBytes,
    totalRequiredBytes,
    spillsToDisk,
    safetyMultiplier,
  };
}

/**
 * Computes estimated temporary space requirements for full table rewrites
 * (e.g. ALTER TABLE ... ALTER COLUMN TYPE, CLUSTER, VACUUM FULL).
 *
 * Formula:
 * - Transient table duplicate: 2x (heap + TOAST)
 * - Rebuilt indexes: 1x all existing index sizes
 * - WAL stream: 1.2x (heap + TOAST)
 * - Total required: (2 * (heap + toast)) + indexes + walBytes
 */
export function estimateTableRewriteSpace(params: TableRewriteEstimateParams): TableRewriteEstimate {
  const heapBytes = Math.max(0, Math.floor(params.heapBytes || 0));
  const toastBytes = Math.max(0, Math.floor(params.toastBytes || 0));
  const indexesBytes = Math.max(0, Math.floor(params.indexesBytes || 0));
  const safetyMultiplier = params.safetyMultiplier ?? 2.0;

  // Table rewrites write a completely new heap and TOAST file before committing
  const transientTableBytes = Math.ceil((heapBytes + toastBytes) * safetyMultiplier);

  // All indexes are rebuilt for the new heap
  const rebuiltIndexesBytes = indexesBytes;

  // Writing new heap and toast generates full WAL logs
  const walBytes = Math.ceil((heapBytes + toastBytes) * 1.2);

  const totalRequiredBytes = transientTableBytes + rebuiltIndexesBytes + walBytes;

  return {
    heapBytes,
    toastBytes,
    indexesBytes,
    transientTableBytes,
    rebuiltIndexesBytes,
    walBytes,
    totalRequiredBytes,
    safetyMultiplier,
  };
}

/**
 * Analyzes PostgreSQL cluster directory topology to detect shared-mount anti-patterns
 * where `data_directory` and `pg_wal` share the same underlying filesystem partition.
 */
export function detectSharedMount(dataDirectory: string, walDirectory?: string): SharedMountAnalysis {
  const normData = path.normalize(dataDirectory || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const effectiveWal = walDirectory && walDirectory.trim() !== ''
    ? path.normalize(walDirectory).replace(/\\/g, '/').replace(/\/+$/, '')
    : `${normData}/pg_wal`;

  // Check if walDirectory is inside or identical to dataDirectory
  const isInsideData = effectiveWal.startsWith(normData);
  const isDefaultSubdir = effectiveWal === `${normData}/pg_wal` || effectiveWal === `${normData}/pg_xlog`;

  const isSharedMount = isInsideData || isDefaultSubdir || normData === effectiveWal;

  if (isSharedMount) {
    return {
      dataDirectory: normData,
      walDirectory: effectiveWal,
      isSharedMount: true,
      risk: 'HIGH',
      warning: `Shared mount detected: pg_wal (${effectiveWal}) and data_directory (${normData}) share the same filesystem partition.`,
      remediation: 'Relocate pg_wal to a dedicated high-throughput NVMe mount using a symlink or custom tablespace to prevent DDL WAL spikes from exhausting heap disk space.',
    };
  }

  return {
    dataDirectory: normData,
    walDirectory: effectiveWal,
    isSharedMount: false,
    risk: 'LOW',
  };
}

/**
 * Validates available OS disk headroom against required operation bytes.
 * Requires at least `safetyMultiplier` headroom and asserts that post-operation
 * free space does not drop below the 15% system threshold.
 */
export function checkDiskHeadroom(
  requiredBytes: number,
  availableBytes: number,
  safetyMultiplier: number = 1.25
): DiskHeadroomReport {
  const effectiveRequired = Math.ceil(requiredBytes * safetyMultiplier);
  const projectedRemaining = availableBytes - requiredBytes;
  const projectedPercent = availableBytes > 0
    ? (projectedRemaining / availableBytes) * 100
    : 0;

  if (availableBytes < effectiveRequired) {
    return {
      availableBytes,
      requiredBytes: effectiveRequired,
      safetyMultiplier,
      hasSufficientSpace: false,
      projectedRemainingBytes: projectedRemaining,
      projectedRemainingPercent: projectedPercent,
      status: 'CRITICAL',
      warning: `Insufficient disk space: Operation requires ${formatBytes(effectiveRequired)} (with ${safetyMultiplier}x headroom), but only ${formatBytes(availableBytes)} is available.`,
    };
  }

  if (projectedPercent < 15) {
    return {
      availableBytes,
      requiredBytes: effectiveRequired,
      safetyMultiplier,
      hasSufficientSpace: true,
      projectedRemainingBytes: projectedRemaining,
      projectedRemainingPercent: projectedPercent,
      status: 'WARNING',
      warning: `Low disk headroom: Operation will consume disk down to ${projectedPercent.toFixed(1)}% free (${formatBytes(projectedRemaining)} remaining). Target >= 15% headroom to avoid database lockouts.`,
    };
  }

  return {
    availableBytes,
    requiredBytes: effectiveRequired,
    safetyMultiplier,
    hasSufficientSpace: true,
    projectedRemainingBytes: projectedRemaining,
    projectedRemainingPercent: projectedPercent,
    status: 'SAFE',
  };
}

/**
 * Runs live disk and mount inspection against a target PostgreSQL instance.
 */
export async function auditDiskGuard(
  client: PgClientLike,
  targetTable: string,
  options: DiskGuardOptions = {}
): Promise<DiskGuardReport> {
  const schema = options.schema || 'public';
  const cleanTable = targetTable.replace(/["`]/g, '');

  // 1. Query settings for paths and memory
  const settingsRes = await client.query(`
    SELECT name, setting
    FROM pg_settings
    WHERE name IN ('data_directory', 'maintenance_work_mem', 'wal_keep_size', 'max_wal_size');
  `);
  const settingsMap = new Map<string, string>();
  for (const row of settingsRes.rows) {
    settingsMap.set(row.name, row.setting);
  }

  const dataDir = settingsMap.get('data_directory') || '/var/lib/postgresql/data';
  const mwmRaw = settingsMap.get('maintenance_work_mem') || '65536'; // kB in pg_settings
  const maintenanceWorkMemBytes = parseInt(mwmRaw, 10) * 1024; // Convert kB to bytes

  const sharedMount = detectSharedMount(dataDir);

  // 2. Query relation statistics
  const statsRes = await client.query(`
    SELECT
      c.reltuples::bigint AS reltuples,
      COALESCE(s.n_live_tup, 0)::bigint AS n_live_tup,
      COALESCE(s.n_dead_tup, 0)::bigint AS n_dead_tup,
      pg_relation_size(c.oid)::bigint AS heap_bytes,
      (pg_total_relation_size(c.oid) - pg_relation_size(c.oid) - COALESCE(pg_indexes_size(c.oid), 0))::bigint AS toast_bytes,
      COALESCE(pg_indexes_size(c.oid), 0)::bigint AS indexes_bytes
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
    WHERE n.nspname = $1 AND c.relname = $2;
  `, [schema, cleanTable]);

  if (statsRes.rows.length === 0) {
    throw new Error(`Table "${schema}"."${cleanTable}" not found in database catalog.`);
  }

  const row = statsRes.rows[0];
  const reltuples = Number(row.reltuples);
  const nLiveTup = Number(row.n_live_tup);
  const nDeadTup = Number(row.n_dead_tup);
  const heapBytes = Number(row.heap_bytes);
  const toastBytes = Math.max(0, Number(row.toast_bytes));
  const indexesBytes = Number(row.indexes_bytes);

  const operation = options.operation === 'table_rewrite' ? 'table_rewrite' : 'create_index';

  let totalRequired = 0;
  let indexEstimate: IndexSpaceEstimate | undefined;
  let rewriteEstimate: TableRewriteEstimate | undefined;

  if (operation === 'create_index') {
    indexEstimate = estimateIndexSpace({
      reltuples,
      nLiveTup,
      nDeadTup,
      tableBytes: heapBytes,
      maintenanceWorkMemBytes: options.maintenanceWorkMemBytes ?? maintenanceWorkMemBytes,
      avgIndexTupleBytes: options.avgIndexTupleBytes,
      safetyMultiplier: options.safetyMultiplier,
    });
    totalRequired = indexEstimate.totalRequiredBytes;
  } else {
    rewriteEstimate = estimateTableRewriteSpace({
      heapBytes,
      toastBytes,
      indexesBytes,
      safetyMultiplier: options.safetyMultiplier,
    });
    totalRequired = rewriteEstimate.totalRequiredBytes;
  }

  // Available bytes fallback
  const availableBytes = options.availableBytes ?? 50 * 1024 * 1024 * 1024; // Default 50GB simulation if unspecified
  const headroom = checkDiskHeadroom(totalRequired, availableBytes, 1.2);

  const passed = headroom.hasSufficientSpace && headroom.status !== 'CRITICAL';
  const summary = `Disk Guard ${passed ? 'PASSED' : 'FAILED'}: Required ${formatBytes(totalRequired)}, Available ${formatBytes(availableBytes)}, Mount: ${sharedMount.isSharedMount ? 'SHARED (Warning)' : 'ISOLATED'}.`;

  return {
    table: cleanTable,
    schema,
    operation,
    sharedMount,
    indexEstimate,
    rewriteEstimate,
    headroom,
    summary,
    passed,
  };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

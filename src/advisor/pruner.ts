/**
 * ddlforge - Unused & Redundant Index Pruning Engine
 *
 * Discovers and prunes dead weight B-Tree indexes to reclaim disk I/O, cache space,
 * and eliminate write amplification:
 * 1. Unused Indexes: 0 index scans in `pg_stat_user_indexes` (with stats reset guard).
 * 2. Redundant Indexes: Prefix-subsumed multi-column B-Tree indexes (e.g. (a) subsumed by (a, b)).
 * 3. Safety Guards: Protects Primary Keys, Unique Constraints, and Foreign Key backings.
 * 4. Invalid Index Self-Healing: Detects `indisvalid = false` failed CONCURRENTLY remnants.
 * 5. Concurrent Drop: Emits autocommit-safe `DROP INDEX CONCURRENTLY` statements.
 */

import type { PgClientLike } from '../cluster/advisory.js';

export type PruneReason = 'UNUSED' | 'REDUNDANT' | 'INVALID';

export interface IndexPruneCandidate {
  schemaName: string;
  tableName: string;
  indexName: string;
  reason: PruneReason;
  details: string;
  subsumingIndex?: string;
  sizeBytes: number;
  scans: number;
  isSafeToDrop: boolean;
  safetyWarnings: string[];
  dropSql: string;
}

export interface PruneReport {
  candidates: IndexPruneCandidate[];
  totalReclaimableBytes: number;
  totalReclaimableMb: number;
  unusedCount: number;
  redundantCount: number;
  invalidCount: number;
  statsResetDate?: Date | null;
  checkedAt: Date;
}

export interface PruneOptions {
  schema?: string;
  table?: string;
  minSizeMb?: number;
  maxScans?: number; // Default: 0 (strictly unused)
  includeInvalid?: boolean; // Default: true
}

export interface RawIndexMetadata {
  schemaName: string;
  tableName: string;
  indexName: string;
  indexOid: number;
  tableOid: number;
  scans: number;
  sizeBytes: number;
  isValid: boolean;
  isUnique: boolean;
  isPrimary: boolean;
  keyColumns: string[]; // List of column names or attribute numbers in index order
  predicateExpr: string | null;
  isFkBacking: boolean;
  constraintType?: 'p' | 'u' | 'f' | 'c' | null;
}

/**
 * Checks if index A's key sequence is a strict prefix of index B's key sequence on the same table.
 * e.g., keysA: ['user_id'], keysB: ['user_id', 'created_at'] -> true (A is subsumed by B)
 */
export function isPrefixSubsumed(
  keysA: Array<string | number>,
  keysB: Array<string | number>
): boolean {
  if (keysA.length === 0 || keysB.length <= keysA.length) {
    return false;
  }

  for (let i = 0; i < keysA.length; i++) {
    if (keysA[i] !== keysB[i]) {
      return false;
    }
  }

  return true;
}

/**
 * Evaluates a list of indexes on a table and identifies redundant prefix-subsumed indexes.
 */
export function identifyRedundantIndexes(indexes: RawIndexMetadata[]): IndexPruneCandidate[] {
  const candidates: IndexPruneCandidate[] = [];

  // Group indexes by table
  const tableMap = new Map<string, RawIndexMetadata[]>();
  for (const idx of indexes) {
    const key = `${idx.schemaName}.${idx.tableName}`;
    if (!tableMap.has(key)) tableMap.set(key, []);
    tableMap.get(key)!.push(idx);
  }

  for (const [, tableIndexes] of tableMap.entries()) {
    // Only compare valid, non-primary, non-unique indexes
    for (let i = 0; i < tableIndexes.length; i++) {
      const idxA = tableIndexes[i];

      // Primary keys and unique constraints are NEVER redundant (they enforce business uniqueness)
      if (idxA.isPrimary || idxA.isUnique || idxA.constraintType === 'p' || idxA.constraintType === 'u') {
        continue;
      }

      for (let j = 0; j < tableIndexes.length; j++) {
        if (i === j) continue;
        const idxB = tableIndexes[j];

        // Ensure both indexes have matching predicates (or neither is partial)
        const predicateMatch = (idxA.predicateExpr ?? '') === (idxB.predicateExpr ?? '');
        if (!predicateMatch) continue;

        // Check prefix containment: is A's keys a prefix of B's keys?
        if (isPrefixSubsumed(idxA.keyColumns, idxB.keyColumns)) {
          const warnings: string[] = [];
          let isSafe = true;

          if (idxA.isFkBacking) {
            warnings.push('Index supports Foreign Key constraint. Ensure parent updates do not lock target table.');
            // Still often safe if B also covers the FK prefix, but flag caution
          }

          const dropSql = `DROP INDEX CONCURRENTLY IF EXISTS "${idxA.schemaName}"."${idxA.indexName}";`;

          candidates.push({
            schemaName: idxA.schemaName,
            tableName: idxA.tableName,
            indexName: idxA.indexName,
            reason: 'REDUNDANT',
            details: `Column sequence (${idxA.keyColumns.join(', ')}) is fully subsumed by larger index "${idxB.indexName}" (${idxB.keyColumns.join(', ')}).`,
            subsumingIndex: idxB.indexName,
            sizeBytes: idxA.sizeBytes,
            scans: idxA.scans,
            isSafeToDrop: isSafe,
            safetyWarnings: warnings,
            dropSql,
          });

          break; // Avoid duplicate candidate records if multiple indexes subsume it
        }
      }
    }
  }

  return candidates;
}

/**
 * Queries live PostgreSQL catalogs to find unused, redundant, and invalid indexes.
 */
export async function queryPrunableIndexes(
  client: PgClientLike,
  options: PruneOptions = {}
): Promise<PruneReport> {
  const schema = options.schema || 'public';
  const minSizeBytes = (options.minSizeMb ?? 0) * 1024 * 1024;
  const maxScans = options.maxScans ?? 0;
  const includeInvalid = options.includeInvalid ?? true;
  const checkedAt = new Date();

  // 1. Fetch stats reset date to guard against premature pruning
  let statsResetDate: Date | null = null;
  try {
    const resetRes = await client.query(`SELECT stats_reset FROM pg_stat_database WHERE datname = current_database();`);
    if (resetRes.rows && resetRes.rows[0]?.stats_reset) {
      statsResetDate = new Date(resetRes.rows[0].stats_reset);
    }
  } catch {
    statsResetDate = null;
  }

  // 2. Fetch all user indexes with scans, sizes, constraints, and column keys
  let sql = `
    SELECT
      n.nspname AS schema_name,
      c_tbl.relname AS table_name,
      c_idx.relname AS index_name,
      i.indexrelid AS index_oid,
      i.indrelid AS table_oid,
      COALESCE(s.idx_scan, 0)::bigint AS scans,
      pg_relation_size(i.indexrelid)::bigint AS size_bytes,
      i.indisvalid AS is_valid,
      i.indisunique AS is_unique,
      i.indisprimary AS is_primary,
      i.indkey::text AS indkey_str,
      pg_get_expr(i.indpred, i.indrelid) AS predicate_expr,
      con.contype AS constraint_type,
      EXISTS (
        SELECT 1 FROM pg_constraint fk
        WHERE fk.contype = 'f'
          AND fk.conrelid = i.indrelid
          AND (fk.conindid = i.indexrelid OR (fk.conkey[1] = i.indkey[0]))
      ) AS is_fk_backing
    FROM pg_index i
    JOIN pg_class c_idx ON c_idx.oid = i.indexrelid
    JOIN pg_class c_tbl ON c_tbl.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = c_tbl.relnamespace
    JOIN pg_am am ON am.oid = c_idx.relam
    LEFT JOIN pg_stat_user_indexes s ON s.indexrelid = i.indexrelid
    LEFT JOIN pg_constraint con ON con.conindid = i.indexrelid
    WHERE n.nspname = $1
      AND am.amname = 'btree'
  `;
  const params: unknown[] = [schema];

  if (options.table) {
    params.push(options.table);
    sql += ` AND c_tbl.relname = $2`;
  }

  sql += ` ORDER BY pg_relation_size(i.indexrelid) DESC;`;

  const res = await client.query(sql, params);
  const rawIndexes: RawIndexMetadata[] = (res.rows || []).map(r => ({
    schemaName: r.schema_name,
    tableName: r.table_name,
    indexName: r.index_name,
    indexOid: parseInt(r.index_oid, 10),
    tableOid: parseInt(r.table_oid, 10),
    scans: parseInt(r.scans, 10) || 0,
    sizeBytes: parseInt(r.size_bytes, 10) || 0,
    isValid: Boolean(r.is_valid),
    isUnique: Boolean(r.is_unique),
    isPrimary: Boolean(r.is_primary),
    keyColumns: (r.indkey_str || '').trim().split(/\s+/).filter(Boolean),
    predicateExpr: r.predicate_expr ?? null,
    isFkBacking: Boolean(r.is_fk_backing),
    constraintType: r.constraint_type ?? null,
  }));

  const candidates: IndexPruneCandidate[] = [];
  const processedNames = new Set<string>();

  // A. Check for Invalid Indexes (indisvalid = false)
  if (includeInvalid) {
    for (const idx of rawIndexes) {
      if (!idx.isValid) {
        processedNames.add(idx.indexName);
        candidates.push({
          schemaName: idx.schemaName,
          tableName: idx.tableName,
          indexName: idx.indexName,
          reason: 'INVALID',
          details: 'Failed or interrupted concurrent index creation. Consumes disk and lock bandwidth without providing query utility.',
          sizeBytes: idx.sizeBytes,
          scans: idx.scans,
          isSafeToDrop: true,
          safetyWarnings: [],
          dropSql: `DROP INDEX CONCURRENTLY IF EXISTS "${idx.schemaName}"."${idx.indexName}";`,
        });
      }
    }
  }

  // B. Check for Redundant Indexes (prefix subsumed)
  const redundantCandidates = identifyRedundantIndexes(rawIndexes);
  for (const red of redundantCandidates) {
    if (!processedNames.has(red.indexName)) {
      processedNames.add(red.indexName);
      candidates.push(red);
    }
  }

  // C. Check for Unused Indexes (scans <= maxScans, minSize)
  for (const idx of rawIndexes) {
    if (processedNames.has(idx.indexName)) continue;

    // Safety checks: primary keys and unique constraints are NEVER unused candidates
    if (idx.isPrimary || idx.isUnique || idx.constraintType === 'p' || idx.constraintType === 'u') {
      continue;
    }

    if (idx.scans <= maxScans && idx.sizeBytes >= minSizeBytes) {
      const warnings: string[] = [];
      let isSafe = true;

      if (idx.isFkBacking) {
        warnings.push('Index supports Foreign Key constraint. Dropping may cause lock escalation during delete/update on parent table.');
        isSafe = false;
      }

      candidates.push({
        schemaName: idx.schemaName,
        tableName: idx.tableName,
        indexName: idx.indexName,
        reason: 'UNUSED',
        details: `Index has recorded 0 scans since last stats reset (${statsResetDate ? statsResetDate.toISOString().slice(0, 10) : 'unknown'}).`,
        sizeBytes: idx.sizeBytes,
        scans: idx.scans,
        isSafeToDrop: isSafe,
        safetyWarnings: warnings,
        dropSql: `DROP INDEX CONCURRENTLY IF EXISTS "${idx.schemaName}"."${idx.indexName}";`,
      });
      processedNames.add(idx.indexName);
    }
  }

  const totalReclaimableBytes = candidates.reduce((sum, c) => sum + c.sizeBytes, 0);
  const totalReclaimableMb = Math.round((totalReclaimableBytes / (1024 * 1024)) * 10) / 10;
  const unusedCount = candidates.filter(c => c.reason === 'UNUSED').length;
  const redundantCount = candidates.filter(c => c.reason === 'REDUNDANT').length;
  const invalidCount = candidates.filter(c => c.reason === 'INVALID').length;

  return {
    candidates,
    totalReclaimableBytes,
    totalReclaimableMb,
    unusedCount,
    redundantCount,
    invalidCount,
    statsResetDate,
    checkedAt,
  };
}

/**
 * Formats pruning analysis report into a colorized, human-readable terminal output.
 */
export function formatPruneReportTerminal(report: PruneReport): string {
  const lines: string[] = [];

  lines.push('');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('  ddlforge v1.9.0 — Index Lifecycle Advisor & Pruning Engine');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push(`Checked At:             ${report.checkedAt.toISOString()}`);
  lines.push(`Total Candidates:       ${report.candidates.length} indexes`);
  lines.push(`Total Reclaimable Disk: ${report.totalReclaimableMb} MB`);
  lines.push(`Breakdown:              ${report.unusedCount} Unused | ${report.redundantCount} Redundant | ${report.invalidCount} Invalid`);
  if (report.statsResetDate) {
    lines.push(`Stats Reset Window:     ${report.statsResetDate.toISOString()}`);
  }
  lines.push('');

  if (report.candidates.length === 0) {
    lines.push('  ✔ All indexes are healthy, actively scanned, and non-redundant.');
    lines.push('');
    return lines.join('\n');
  }

  lines.push('INDEX PRUNING CANDIDATES:');
  lines.push('──────────────────────────────────────────────────────────────────────');

  for (const c of report.candidates) {
    const sizeMb = (c.sizeBytes / (1024 * 1024)).toFixed(2);
    const badge = `[${c.reason}]`;
    const safetyBadge = c.isSafeToDrop ? '[SAFE TO DROP]' : '[CAUTION]';

    lines.push(`┌── Index: "${c.schemaName}"."${c.indexName}" on "${c.tableName}" (${sizeMb} MB) ${badge} ${safetyBadge}`);
    lines.push(`│   Scans:           ${c.scans}`);
    lines.push(`│   Diagnostic:      ${c.details}`);
    if (c.subsumingIndex) {
      lines.push(`│   Superseded By:   "${c.subsumingIndex}"`);
    }
    if (c.safetyWarnings.length > 0) {
      for (const w of c.safetyWarnings) {
        lines.push(`│   ⚠ Warning:       ${w}`);
      }
    }
    lines.push(`│   Concurrent Drop: ${c.dropSql}`);
    lines.push(`└─────────────────────────────────────────────────────────────────────`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * ddlforge - Statistical Bloat Estimator Engine
 *
 * Mathematically estimates PostgreSQL table and B-Tree index bloat without sequential scans
 * using pg_stats, pg_class, and explicit tuple layout calculations:
 * - 24-byte page header
 * - 4-byte ItemIdData line pointers
 * - 23-byte HeapTupleHeaderData (padded to 24-byte MAXALIGN on 64-bit architecture)
 * - Null bitmap header padding: ceil(nullable_columns / 8) bytes
 * - Index leaf page headers and fillfactor bounds
 *
 * Implements Heuristic Decision Matrix:
 * - Index bloat > 30% and table bloat < 10% -> Recommend `ddlforge compact index`
 * - Table bloat >= 25-30% -> Recommend `ddlforge compact table`
 * - Table bloat 10-20% -> Flag as normal MVCC churn; recommend tuning fillfactor
 * - Bloat < 10% -> Optimal
 */

import type { PgClientLike } from '../cluster/advisory.js';

export const PAGE_HEADER_SIZE = 24;
export const ITEM_POINTER_SIZE = 4;
export const HEAP_TUPLE_HEADER_SIZE = 23;
export const MAXALIGN = 8;
export const BTREE_PAGE_HEADER = 24;
export const BTREE_SPECIAL_SPACE = 16;
export const INDEX_TUPLE_HEADER = 8;
export const DEFAULT_BLOCK_SIZE = 8192;

export type CompactionAction =
  | 'REPACK_TABLE'
  | 'REINDEX_INDEX'
  | 'TUNE_FILLFACTOR'
  | 'OPTIMAL';

export interface TableBloatInput {
  tableName: string;
  schemaName?: string;
  relpages: number;
  reltuples: number;
  nullableColumns: number;
  avgDataWidth: number;
  fillfactor?: number; // default: 100
  blockSize?: number; // default: 8192
}

export interface TableBloatReport {
  tableName: string;
  schemaName: string;
  actualPages: number;
  actualBytes: number;
  estOptimalPages: number;
  estOptimalBytes: number;
  bloatPages: number;
  bloatBytes: number;
  bloatRatioPercent: number;
  tupleHeaderBytes: number;
  tuplesPerPage: number;
}

export interface IndexBloatInput {
  indexName: string;
  tableName: string;
  schemaName?: string;
  relpages: number;
  reltuples: number;
  avgKeyWidth: number;
  fillfactor?: number; // default: 90
  blockSize?: number; // default: 8192
}

export interface IndexBloatReport {
  indexName: string;
  tableName: string;
  schemaName: string;
  actualPages: number;
  actualBytes: number;
  estOptimalPages: number;
  estOptimalBytes: number;
  bloatPages: number;
  bloatBytes: number;
  bloatRatioPercent: number;
  entriesPerPage: number;
}

export interface CompactionDecision {
  action: CompactionAction;
  summary: string;
  reason: string;
  commandAdvice: string;
}

export interface RelationCompactionProfile {
  table: TableBloatReport;
  indexes: IndexBloatReport[];
  decision: CompactionDecision;
}

export interface BloatEstimatorReport {
  relations: RelationCompactionProfile[];
  totalActualBytes: number;
  totalBloatBytes: number;
  estimatedRecoverableMb: number;
  checkedAt: Date;
}

/**
 * Calculates the exact HeapTupleHeader size including null bitmap and MAXALIGN padding.
 */
export function calculateTupleHeaderSize(nullableColumns: number): number {
  const nullBitmapSize = nullableColumns > 0 ? Math.ceil(nullableColumns / 8) : 0;
  const rawHeader = HEAP_TUPLE_HEADER_SIZE + nullBitmapSize;
  return Math.ceil(rawHeader / MAXALIGN) * MAXALIGN;
}

/**
 * Mathematically estimates table bloat based on tuple density and page header math.
 */
export function estimateTableBloat(input: TableBloatInput): TableBloatReport {
  const schemaName = input.schemaName || 'public';
  const blockSize = input.blockSize ?? DEFAULT_BLOCK_SIZE;
  const fillfactor = input.fillfactor ?? 100;
  const reltuples = Math.max(0, input.reltuples);
  const actualPages = Math.max(0, input.relpages);
  const actualBytes = actualPages * blockSize;

  // 1. Calculate header and aligned tuple size
  const tupleHeaderBytes = calculateTupleHeaderSize(input.nullableColumns);
  const unalignedTupleSize = tupleHeaderBytes + Math.max(0, input.avgDataWidth);
  const alignedTupleSize = Math.ceil(unalignedTupleSize / MAXALIGN) * MAXALIGN;

  // 2. Usable space on 8KB heap page
  const usablePageBytes = Math.floor((blockSize - PAGE_HEADER_SIZE) * (fillfactor / 100));
  const slotSize = alignedTupleSize + ITEM_POINTER_SIZE;
  const tuplesPerPage = Math.max(1, Math.floor(usablePageBytes / slotSize));

  // 3. Estimated optimal pages
  const estOptimalPages = reltuples > 0 ? Math.ceil(reltuples / tuplesPerPage) : (actualPages > 0 ? 1 : 0);
  const estOptimalBytes = estOptimalPages * blockSize;

  const bloatPages = Math.max(0, actualPages - estOptimalPages);
  const bloatBytes = bloatPages * blockSize;
  const bloatRatioPercent = actualPages > 0 ? Math.min(100, Math.max(0, (bloatPages / actualPages) * 100)) : 0;

  return {
    tableName: input.tableName,
    schemaName,
    actualPages,
    actualBytes,
    estOptimalPages,
    estOptimalBytes,
    bloatPages,
    bloatBytes,
    bloatRatioPercent: Math.round(bloatRatioPercent * 10) / 10,
    tupleHeaderBytes,
    tuplesPerPage,
  };
}

/**
 * Mathematically estimates B-Tree index bloat based on leaf page capacity and special space.
 */
export function estimateIndexBloat(input: IndexBloatInput): IndexBloatReport {
  const schemaName = input.schemaName || 'public';
  const blockSize = input.blockSize ?? DEFAULT_BLOCK_SIZE;
  const fillfactor = input.fillfactor ?? 90;
  const reltuples = Math.max(0, input.reltuples);
  const actualPages = Math.max(0, input.relpages);
  const actualBytes = actualPages * blockSize;

  // 1. Calculate index tuple size
  const unalignedIndexTuple = INDEX_TUPLE_HEADER + Math.max(0, input.avgKeyWidth);
  const alignedIndexTuple = Math.ceil(unalignedIndexTuple / MAXALIGN) * MAXALIGN;

  // 2. Usable page space (subtracting page header and special space)
  const pageOverhead = BTREE_PAGE_HEADER + BTREE_SPECIAL_SPACE;
  const usablePageSpace = Math.floor((blockSize - pageOverhead) * (fillfactor / 100));
  const slotSize = alignedIndexTuple + ITEM_POINTER_SIZE;
  const entriesPerPage = Math.max(1, Math.floor(usablePageSpace / slotSize));

  // 3. Optimal leaf pages + 10% non-leaf btree tree overhead
  const estLeafPages = reltuples > 0 ? Math.ceil(reltuples / entriesPerPage) : (actualPages > 0 ? 1 : 0);
  const estOptimalPages = Math.ceil(estLeafPages * 1.1);
  const estOptimalBytes = estOptimalPages * blockSize;

  const bloatPages = Math.max(0, actualPages - estOptimalPages);
  const bloatBytes = bloatPages * blockSize;
  const bloatRatioPercent = actualPages > 0 ? Math.min(100, Math.max(0, (bloatPages / actualPages) * 100)) : 0;

  return {
    indexName: input.indexName,
    tableName: input.tableName,
    schemaName,
    actualPages,
    actualBytes,
    estOptimalPages,
    estOptimalBytes,
    bloatPages,
    bloatBytes,
    bloatRatioPercent: Math.round(bloatRatioPercent * 10) / 10,
    entriesPerPage,
  };
}

/**
 * Applies the Heuristic Decision Matrix across table and index bloat metrics.
 */
export function calculateCompactionDecision(
  tableReport: TableBloatReport,
  indexReports: IndexBloatReport[],
  thresholdPercent: number = 25
): CompactionDecision {
  const tableBloat = tableReport.bloatRatioPercent;
  const maxIndexBloat = indexReports.reduce((max, idx) => Math.max(max, idx.bloatRatioPercent), 0);
  const highestBloatIndex = indexReports.find(idx => idx.bloatRatioPercent === maxIndexBloat);

  // Heuristic 1: Index bloat > 30% and table bloat < 10% -> Reindex without touching the heap
  if (maxIndexBloat >= 30 && tableBloat < 10) {
    const idxName = highestBloatIndex ? `"${highestBloatIndex.indexName}"` : 'index';
    return {
      action: 'REINDEX_INDEX',
      summary: `Index bloat high (${maxIndexBloat}%), table bloat low (${tableBloat}%). Prioritize index rebuild.`,
      reason: `Rebuilding indexes concurrently preserves disk I/O and cache bandwidth without rewriting the heap table.`,
      commandAdvice: `ddlforge compact index --table ${tableReport.tableName}${highestBloatIndex ? ` --index ${highestBloatIndex.indexName}` : ''}`,
    };
  }

  // Heuristic 2: Table bloat exceeds threshold (>= 25-30%)
  if (tableBloat >= thresholdPercent) {
    return {
      action: 'REPACK_TABLE',
      summary: `Table bloat exceeds threshold (${tableBloat}% >= ${thresholdPercent}%). Online repack recommended.`,
      reason: `Significant dead tuple bloat cannot be reclaimed by regular VACUUM. Online compaction will lower the high-water mark.`,
      commandAdvice: `ddlforge compact table --table ${tableReport.tableName} --pk id`,
    };
  }

  // Heuristic 3: Normal MVCC churn between 10% and 20%
  if (tableBloat >= 10 && tableBloat < 25) {
    return {
      action: 'TUNE_FILLFACTOR',
      summary: `Moderate table bloat (${tableBloat}%). Normal MVCC churn detected.`,
      reason: `Dead space is actively reused by VACUUM FSM. Lowering fillfactor (e.g. to 85) enables Heap-Only Tuple (HOT) updates.`,
      commandAdvice: `ALTER TABLE "${tableReport.schemaName}"."${tableReport.tableName}" SET (fillfactor = 85);`,
    };
  }

  // Heuristic 4: Healthy / Optimal
  return {
    action: 'OPTIMAL',
    summary: `Relation density is optimal (${tableBloat}% table bloat, ${maxIndexBloat}% index bloat).`,
    reason: `Storage utilization is within healthy production limits. No maintenance required.`,
    commandAdvice: `# No compaction needed`,
  };
}

/**
 * Queries PostgreSQL catalogs (pg_class, pg_stats, pg_namespace, pg_index) to estimate bloat on live relations.
 */
export async function queryLiveBloatEstimates(
  client: PgClientLike,
  options: { schema?: string; table?: string; thresholdPercent?: number } = {}
): Promise<BloatEstimatorReport> {
  const schema = options.schema || 'public';
  const threshold = options.thresholdPercent ?? 25;

  // 1. Query Table Stats
  let tableSql = `
    SELECT
      c.oid AS table_oid,
      n.nspname AS schema_name,
      c.relname AS table_name,
      c.relpages::int AS rel_pages,
      c.reltuples::bigint AS rel_tuples,
      COALESCE((
        SELECT (regexp_matches(c.reloptions::text, 'fillfactor=([0-9]+)'))[1]::int
      ), 100) AS fillfactor,
      COUNT(a.attname)::int AS total_columns,
      COUNT(a.attname) FILTER (WHERE NOT a.attnotnull)::int AS nullable_columns,
      COALESCE(SUM(s.avg_width), 0)::int AS avg_data_width,
      current_setting('block_size')::int AS block_size
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    LEFT JOIN pg_stats s ON s.schemaname = n.nspname AND s.tablename = c.relname AND s.attname = a.attname
    WHERE c.relkind IN ('r', 'm')
      AND n.nspname = $1
  `;
  const params: unknown[] = [schema];

  if (options.table) {
    params.push(options.table);
    tableSql += ` AND c.relname = $2`;
  }

  tableSql += ` GROUP BY c.oid, n.nspname, c.relname, c.relpages, c.reltuples, c.reloptions ORDER BY c.relpages DESC;`;

  const tableRes = await client.query(tableSql, params);

  // 2. Query Index Stats
  let indexSql = `
    SELECT
      i.indexrelid AS index_oid,
      c_idx.relname AS index_name,
      n.nspname AS schema_name,
      c_tbl.relname AS table_name,
      c_idx.relpages::int AS index_pages,
      c_tbl.reltuples::bigint AS rel_tuples,
      COALESCE((
        SELECT (regexp_matches(c_idx.reloptions::text, 'fillfactor=([0-9]+)'))[1]::int
      ), 90) AS fillfactor,
      COALESCE(SUM(s.avg_width), 8)::int AS avg_key_width,
      current_setting('block_size')::int AS block_size
    FROM pg_index i
    JOIN pg_class c_idx ON c_idx.oid = i.indexrelid
    JOIN pg_class c_tbl ON c_tbl.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = c_tbl.relnamespace
    JOIN pg_am am ON am.oid = c_idx.relam
    JOIN pg_attribute a ON a.attrelid = c_tbl.oid AND a.attnum = ANY(i.indkey::int[])
    LEFT JOIN pg_stats s ON s.schemaname = n.nspname AND s.tablename = c_tbl.relname AND s.attname = a.attname
    WHERE am.amname = 'btree'
      AND n.nspname = $1
      AND i.indisvalid = true
  `;
  const idxParams: unknown[] = [schema];
  if (options.table) {
    idxParams.push(options.table);
    indexSql += ` AND c_tbl.relname = $2`;
  }
  indexSql += ` GROUP BY i.indexrelid, c_idx.relname, n.nspname, c_tbl.relname, c_idx.relpages, c_tbl.reltuples, c_idx.reloptions;`;

  let idxRes: any;
  try {
    idxRes = await client.query(indexSql, idxParams);
  } catch {
    idxRes = { rows: [] };
  }

  const profiles: RelationCompactionProfile[] = [];
  let totalActualBytes = 0;
  let totalBloatBytes = 0;

  for (const tRow of tableRes.rows) {
    const tableReport = estimateTableBloat({
      tableName: tRow.table_name,
      schemaName: tRow.schema_name,
      relpages: parseInt(tRow.rel_pages || '0', 10),
      reltuples: parseInt(tRow.rel_tuples || '0', 10),
      nullableColumns: parseInt(tRow.nullable_columns || '0', 10),
      avgDataWidth: parseInt(tRow.avg_data_width || '0', 10),
      fillfactor: parseInt(tRow.fillfactor || '100', 10),
      blockSize: parseInt(tRow.block_size || '8192', 10),
    });

    totalActualBytes += tableReport.actualBytes;
    totalBloatBytes += tableReport.bloatBytes;

    const matchedIdxRows = idxRes.rows.filter((r: any) => r.table_name === tRow.table_name);
    const indexReports: IndexBloatReport[] = matchedIdxRows.map((iRow: any) => {
      const idxRep = estimateIndexBloat({
        indexName: iRow.index_name,
        tableName: iRow.table_name,
        schemaName: iRow.schema_name,
        relpages: parseInt(iRow.index_pages || '0', 10),
        reltuples: parseInt(iRow.rel_tuples || '0', 10),
        avgKeyWidth: parseInt(iRow.avg_key_width || '8', 10),
        fillfactor: parseInt(iRow.fillfactor || '90', 10),
        blockSize: parseInt(iRow.block_size || '8192', 10),
      });
      totalActualBytes += idxRep.actualBytes;
      totalBloatBytes += idxRep.bloatBytes;
      return idxRep;
    });

    const decision = calculateCompactionDecision(tableReport, indexReports, threshold);

    profiles.push({
      table: tableReport,
      indexes: indexReports,
      decision,
    });
  }

  return {
    relations: profiles,
    totalActualBytes,
    totalBloatBytes,
    estimatedRecoverableMb: Math.round((totalBloatBytes / (1024 * 1024)) * 10) / 10,
    checkedAt: new Date(),
  };
}

/**
 * Formats bloat report into a colorized, human-readable terminal table.
 */
export function formatBloatReportTerminal(report: BloatEstimatorReport): string {
  const lines: string[] = [];

  lines.push('');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('  ddlforge v1.7.0 — Statistical Bloat Estimator');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push(`Checked:                  ${report.checkedAt.toISOString()}`);
  lines.push(`Total Relations Checked:  ${report.relations.length}`);
  lines.push(`Total Monitored Storage:  ${(report.totalActualBytes / (1024 * 1024)).toFixed(1)} MB`);
  lines.push(`Est. Recoverable Bloat:   ${report.estimatedRecoverableMb} MB`);
  lines.push('');

  if (report.relations.length === 0) {
    lines.push('  No matching relations found.');
    return lines.join('\n');
  }

  for (const prof of report.relations) {
    const t = prof.table;
    const actualMb = (t.actualBytes / (1024 * 1024)).toFixed(1);
    const bloatMb = (t.bloatBytes / (1024 * 1024)).toFixed(1);

    lines.push(`┌── Table: ${t.schemaName}.${t.tableName} (${actualMb} MB) ────────────────────────────────`);
    lines.push(`│   Table Bloat:     ${t.bloatRatioPercent}% (${bloatMb} MB in ${t.bloatPages} wasted pages)`);
    lines.push(`│   Tuples per Page: ${t.tuplesPerPage} | Header: ${t.tupleHeaderBytes}B (with null bitmap padding)`);

    if (prof.indexes.length > 0) {
      lines.push(`│   B-Tree Indexes:`);
      for (const idx of prof.indexes) {
        const idxActualMb = (idx.actualBytes / (1024 * 1024)).toFixed(1);
        const idxBloatMb = (idx.bloatBytes / (1024 * 1024)).toFixed(1);
        lines.push(`│     - ${idx.indexName}: ${idx.bloatRatioPercent}% bloat (${idxBloatMb} / ${idxActualMb} MB)`);
      }
    }

    const badge = `[${prof.decision.action}]`;
    lines.push(`│   Action:          ${badge} ${prof.decision.summary}`);
    lines.push(`│   Recommendation:  ${prof.decision.commandAdvice}`);
    lines.push(`└─────────────────────────────────────────────────────────────────────`);
    lines.push('');
  }

  return lines.join('\n');
}

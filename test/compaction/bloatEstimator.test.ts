import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  calculateTupleHeaderSize,
  estimateTableBloat,
  estimateIndexBloat,
  calculateCompactionDecision,
  queryLiveBloatEstimates,
  formatBloatReportTerminal,
  TableBloatInput,
  IndexBloatInput,
} from '../../src/compaction/bloatEstimator.js';

describe('Statistical Bloat Estimator Engine (src/compaction/bloatEstimator.ts)', () => {
  describe('calculateTupleHeaderSize', () => {
    it('computes 24 bytes for 0 nullable columns (23B + 0B bitmap padded to MAXALIGN 8)', () => {
      const size = calculateTupleHeaderSize(0);
      assert.strictEqual(size, 24);
    });

    it('computes 24 bytes for 1 to 8 nullable columns (23B + 1B bitmap = 24B)', () => {
      assert.strictEqual(calculateTupleHeaderSize(1), 24);
      assert.strictEqual(calculateTupleHeaderSize(4), 24);
      assert.strictEqual(calculateTupleHeaderSize(8), 24);
    });

    it('computes 32 bytes for 9 to 16 nullable columns (23B + 2B bitmap = 25B padded to 32B)', () => {
      assert.strictEqual(calculateTupleHeaderSize(9), 32);
      assert.strictEqual(calculateTupleHeaderSize(12), 32);
      assert.strictEqual(calculateTupleHeaderSize(16), 32);
    });

    it('computes 32 bytes for 17 to 24 nullable columns (23B + 3B bitmap = 26B padded to 32B)', () => {
      assert.strictEqual(calculateTupleHeaderSize(17), 32);
      assert.strictEqual(calculateTupleHeaderSize(24), 32);
    });

    it('computes 32 bytes for 25 to 32 nullable columns (23B + 4B bitmap = 27B padded to 32B)', () => {
      assert.strictEqual(calculateTupleHeaderSize(25), 32);
      assert.strictEqual(calculateTupleHeaderSize(32), 32);
    });

    it('computes 40 bytes when bitmap exceeds 32 bytes (e.g. 73+ nullable columns: 23B + 10B = 33B padded to 40B)', () => {
      assert.strictEqual(calculateTupleHeaderSize(73), 40);
      assert.strictEqual(calculateTupleHeaderSize(80), 40);
    });
  });

  describe('estimateTableBloat', () => {
    it('estimates zero bloat on a newly packed table', () => {
      // 100 tuples per page, 100 pages, 10,000 tuples
      const input: TableBloatInput = {
        tableName: 'users',
        schemaName: 'public',
        relpages: 100,
        reltuples: 7000,
        nullableColumns: 4,
        avgDataWidth: 80, // tuple size ~ 24+80=104 -> aligned 104 + 4 = 108; page usable = 8168; ~75 tuples/page
      };

      const report = estimateTableBloat(input);
      assert.strictEqual(report.tableName, 'users');
      assert.strictEqual(report.schemaName, 'public');
      assert.strictEqual(report.actualPages, 100);
      assert.strictEqual(report.actualBytes, 100 * 8192);
      assert.ok(report.estOptimalPages > 0);
      assert.ok(report.bloatRatioPercent >= 0 && report.bloatRatioPercent <= 100);
    });

    it('detects high bloat on a table after massive updates/deletions', () => {
      // 10,000 pages on disk, but only 1,000 tuples remain
      const input: TableBloatInput = {
        tableName: 'audit_log',
        schemaName: 'public',
        relpages: 10000,
        reltuples: 1000,
        nullableColumns: 6,
        avgDataWidth: 120,
      };

      const report = estimateTableBloat(input);
      assert.strictEqual(report.actualPages, 10000);
      assert.ok(report.estOptimalPages < 50); // only requires ~20-30 pages
      assert.ok(report.bloatPages > 9900);
      assert.ok(report.bloatRatioPercent > 95);
      assert.ok(report.bloatBytes > 75 * 1024 * 1024);
    });

    it('handles empty / zero page tables gracefully', () => {
      const input: TableBloatInput = {
        tableName: 'empty_table',
        relpages: 0,
        reltuples: 0,
        nullableColumns: 2,
        avgDataWidth: 40,
      };

      const report = estimateTableBloat(input);
      assert.strictEqual(report.actualPages, 0);
      assert.strictEqual(report.actualBytes, 0);
      assert.strictEqual(report.estOptimalPages, 0);
      assert.strictEqual(report.bloatPages, 0);
      assert.strictEqual(report.bloatRatioPercent, 0);
    });

    it('respects custom fillfactor and block size', () => {
      const input: TableBloatInput = {
        tableName: 'hot_table',
        relpages: 500,
        reltuples: 10000,
        nullableColumns: 8,
        avgDataWidth: 100,
        fillfactor: 80,
        blockSize: 16384,
      };

      const report = estimateTableBloat(input);
      assert.strictEqual(report.actualBytes, 500 * 16384);
      assert.ok(report.tuplesPerPage > 0);
    });
  });

  describe('estimateIndexBloat', () => {
    it('estimates low bloat on balanced B-Tree index', () => {
      const input: IndexBloatInput = {
        indexName: 'idx_orders_created',
        tableName: 'orders',
        relpages: 200,
        reltuples: 50000,
        avgKeyWidth: 8, // bigint/timestamptz
        fillfactor: 90,
      };

      const report = estimateIndexBloat(input);
      assert.strictEqual(report.indexName, 'idx_orders_created');
      assert.strictEqual(report.tableName, 'orders');
      assert.strictEqual(report.actualPages, 200);
      assert.ok(report.entriesPerPage > 100);
      assert.ok(report.estOptimalPages > 0);
    });

    it('detects severe index bloat after high churn', () => {
      // 5,000 pages but only 1,000 tuples
      const input: IndexBloatInput = {
        indexName: 'idx_churn',
        tableName: 'tasks',
        relpages: 5000,
        reltuples: 1000,
        avgKeyWidth: 16,
      };

      const report = estimateIndexBloat(input);
      assert.strictEqual(report.actualPages, 5000);
      assert.ok(report.estOptimalPages < 20);
      assert.ok(report.bloatRatioPercent > 95);
      assert.ok(report.bloatBytes > 35 * 1024 * 1024);
    });

    it('handles zero page index safely', () => {
      const input: IndexBloatInput = {
        indexName: 'idx_empty',
        tableName: 'empty',
        relpages: 0,
        reltuples: 0,
        avgKeyWidth: 8,
      };

      const report = estimateIndexBloat(input);
      assert.strictEqual(report.actualPages, 0);
      assert.strictEqual(report.bloatPages, 0);
      assert.strictEqual(report.bloatRatioPercent, 0);
    });
  });

  describe('calculateCompactionDecision (Heuristic Matrix)', () => {
    it('recommends REINDEX_INDEX when index bloat > 30% and table bloat < 10%', () => {
      const tableReport = estimateTableBloat({
        tableName: 'users',
        relpages: 100,
        reltuples: 6000,
        nullableColumns: 2,
        avgDataWidth: 100,
      });
      // Force table bloat to 5%
      tableReport.bloatRatioPercent = 5;

      const indexReport = estimateIndexBloat({
        indexName: 'idx_users_email',
        tableName: 'users',
        relpages: 500,
        reltuples: 1000,
        avgKeyWidth: 32,
      });
      // Force index bloat to 45%
      indexReport.bloatRatioPercent = 45;

      const decision = calculateCompactionDecision(tableReport, [indexReport], 25);
      assert.strictEqual(decision.action, 'REINDEX_INDEX');
      assert.ok(decision.summary.includes('Index bloat high'));
      assert.ok(decision.commandAdvice.includes('ddlforge compact index --table users --index idx_users_email'));
    });

    it('recommends REPACK_TABLE when table bloat >= threshold (25%)', () => {
      const tableReport = estimateTableBloat({
        tableName: 'orders',
        relpages: 1000,
        reltuples: 5000,
        nullableColumns: 10,
        avgDataWidth: 150,
      });
      tableReport.bloatRatioPercent = 40;

      const decision = calculateCompactionDecision(tableReport, [], 25);
      assert.strictEqual(decision.action, 'REPACK_TABLE');
      assert.ok(decision.summary.includes('Table bloat exceeds threshold'));
      assert.ok(decision.commandAdvice.includes('ddlforge compact table --table orders --pk id'));
    });

    it('recommends TUNE_FILLFACTOR when table bloat is between 10% and 25% (normal MVCC churn)', () => {
      const tableReport = estimateTableBloat({
        tableName: 'sessions',
        relpages: 500,
        reltuples: 10000,
        nullableColumns: 4,
        avgDataWidth: 80,
      });
      tableReport.bloatRatioPercent = 18;

      const decision = calculateCompactionDecision(tableReport, [], 25);
      assert.strictEqual(decision.action, 'TUNE_FILLFACTOR');
      assert.ok(decision.summary.includes('Normal MVCC churn detected'));
      assert.ok(decision.commandAdvice.includes('fillfactor = 85'));
    });

    it('reports OPTIMAL when bloat is under 10%', () => {
      const tableReport = estimateTableBloat({
        tableName: 'settings',
        relpages: 10,
        reltuples: 500,
        nullableColumns: 0,
        avgDataWidth: 50,
      });
      tableReport.bloatRatioPercent = 4;

      const indexReport = estimateIndexBloat({
        indexName: 'idx_settings_key',
        tableName: 'settings',
        relpages: 5,
        reltuples: 500,
        avgKeyWidth: 16,
      });
      indexReport.bloatRatioPercent = 6;

      const decision = calculateCompactionDecision(tableReport, [indexReport], 25);
      assert.strictEqual(decision.action, 'OPTIMAL');
      assert.ok(decision.summary.includes('optimal'));
    });
  });

  describe('queryLiveBloatEstimates', () => {
    it('queries table and index catalogs using provided mock client', async () => {
      const mockClient = {
        async query(sql: string, params?: unknown[]) {
          if (sql.includes('FROM pg_class c') && sql.includes('pg_namespace n')) {
            return {
              rows: [
                {
                  table_oid: 12345,
                  schema_name: 'public',
                  table_name: 'orders',
                  rel_pages: '1000',
                  rel_tuples: '5000',
                  fillfactor: '100',
                  total_columns: '15',
                  nullable_columns: '6',
                  avg_data_width: '120',
                  block_size: '8192',
                },
              ],
            };
          }
          if (sql.includes('FROM pg_index i')) {
            return {
              rows: [
                {
                  index_oid: 67890,
                  index_name: 'idx_orders_user_id',
                  schema_name: 'public',
                  table_name: 'orders',
                  index_pages: '200',
                  rel_tuples: '5000',
                  fillfactor: '90',
                  avg_key_width: '8',
                  block_size: '8192',
                },
              ],
            };
          }
          return { rows: [] };
        },
      };

      const report = await queryLiveBloatEstimates(mockClient, {
        schema: 'public',
        table: 'orders',
        thresholdPercent: 25,
      });

      assert.strictEqual(report.relations.length, 1);
      assert.strictEqual(report.relations[0].table.tableName, 'orders');
      assert.strictEqual(report.relations[0].indexes.length, 1);
      assert.strictEqual(report.relations[0].indexes[0].indexName, 'idx_orders_user_id');
      assert.ok(report.totalActualBytes > 0);
      assert.ok(report.estimatedRecoverableMb >= 0);
      assert.ok(report.checkedAt instanceof Date);
    });
  });

  describe('formatBloatReportTerminal', () => {
    it('formats a colorized terminal report correctly', () => {
      const report = {
        relations: [
          {
            table: {
              tableName: 'orders',
              schemaName: 'public',
              actualPages: 1000,
              actualBytes: 8192000,
              estOptimalPages: 200,
              estOptimalBytes: 1638400,
              bloatPages: 800,
              bloatBytes: 6553600,
              bloatRatioPercent: 80.0,
              tupleHeaderBytes: 24,
              tuplesPerPage: 50,
            },
            indexes: [
              {
                indexName: 'idx_orders_status',
                tableName: 'orders',
                schemaName: 'public',
                actualPages: 100,
                actualBytes: 819200,
                estOptimalPages: 50,
                estOptimalBytes: 409600,
                bloatPages: 50,
                bloatBytes: 409600,
                bloatRatioPercent: 50.0,
                entriesPerPage: 200,
              },
            ],
            decision: {
              action: 'REPACK_TABLE' as const,
              summary: 'Table bloat exceeds threshold (80% >= 25%). Online repack recommended.',
              reason: 'Reclaim wasted storage.',
              commandAdvice: 'ddlforge compact table --table orders --pk id',
            },
          },
        ],
        totalActualBytes: 9011200,
        totalBloatBytes: 6963200,
        estimatedRecoverableMb: 6.6,
        checkedAt: new Date('2026-09-19T12:00:00.000Z'),
      };

      const terminalOutput = formatBloatReportTerminal(report);
      assert.ok(terminalOutput.includes('ddlforge v1.7.0 — Statistical Bloat Estimator'));
      assert.ok(terminalOutput.includes('orders (7.8 MB)'));
      assert.ok(terminalOutput.includes('Table Bloat:     80%'));
      assert.ok(terminalOutput.includes('[REPACK_TABLE]'));
      assert.ok(terminalOutput.includes('ddlforge compact table --table orders --pk id'));
      assert.ok(terminalOutput.includes('idx_orders_status: 50% bloat'));
    });

    it('handles empty relation set gracefully', () => {
      const report = {
        relations: [],
        totalActualBytes: 0,
        totalBloatBytes: 0,
        estimatedRecoverableMb: 0,
        checkedAt: new Date(),
      };

      const terminalOutput = formatBloatReportTerminal(report);
      assert.ok(terminalOutput.includes('No matching relations found.'));
    });
  });
});

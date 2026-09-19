import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  calculateReadWriteRatio,
  calculateHotEfficiency,
  classifyWorkload,
  evaluateIndexingRisk,
  harvestTableTelemetry,
  harvestQueryTelemetry,
  harvestFullWorkloadReport,
  formatWorkloadReportTerminal,
  TableWorkloadProfile,
  WorkloadAnalysisReport,
} from '../../src/advisor/telemetryHarvester.js';
import type { PgClientLike } from '../../src/cluster/advisory.js';

describe('Autonomous Query Telemetry & Workload Analyzer (src/advisor/telemetryHarvester.ts)', () => {
  describe('calculateReadWriteRatio', () => {
    it('returns 100 when there are reads and 0 writes', () => {
      const reads = { idxTupFetch: 500, seqTupRead: 500 };
      const writes = { nTupIns: 0, nTupUpd: 0, nTupDel: 0 };
      const ratio = calculateReadWriteRatio(reads, writes);
      assert.strictEqual(ratio, 100);
    });

    it('returns 1.0 when there are 0 reads and 0 writes', () => {
      const reads = { idxTupFetch: 0, seqTupRead: 0 };
      const writes = { nTupIns: 0, nTupUpd: 0, nTupDel: 0 };
      const ratio = calculateReadWriteRatio(reads, writes);
      assert.strictEqual(ratio, 1.0);
    });

    it('calculates ratio correctly and rounds to 2 decimal places', () => {
      const reads = { idxTupFetch: 750, seqTupRead: 250 }; // 1000
      const writes = { nTupIns: 100, nTupUpd: 150, nTupDel: 50 }; // 300
      const ratio = calculateReadWriteRatio(reads, writes);
      assert.strictEqual(ratio, 3.33);
    });

    it('handles negative inputs safely by clamping to 0', () => {
      const reads = { idxTupFetch: -50, seqTupRead: 200 };
      const writes = { nTupIns: 100, nTupUpd: -20, nTupDel: 0 };
      const ratio = calculateReadWriteRatio(reads, writes);
      assert.strictEqual(ratio, 2.0);
    });
  });

  describe('calculateHotEfficiency', () => {
    it('returns 100 when total updates is 0', () => {
      assert.strictEqual(calculateHotEfficiency(0, 0), 100);
    });

    it('calculates HOT percentage accurately and rounds to 1 decimal place', () => {
      assert.strictEqual(calculateHotEfficiency(85, 100), 85.0);
      assert.strictEqual(calculateHotEfficiency(1, 3), 33.3);
      assert.strictEqual(calculateHotEfficiency(0, 50), 0.0);
    });

    it('clamps negative numbers safely', () => {
      assert.strictEqual(calculateHotEfficiency(-10, 100), 0.0);
    });
  });

  describe('classifyWorkload', () => {
    it('classifies READ_HEAVY for ratio >= 10', () => {
      assert.strictEqual(classifyWorkload(10.0), 'READ_HEAVY');
      assert.strictEqual(classifyWorkload(25.5), 'READ_HEAVY');
    });

    it('classifies BALANCED for 3 <= ratio < 10', () => {
      assert.strictEqual(classifyWorkload(3.0), 'BALANCED');
      assert.strictEqual(classifyWorkload(9.9), 'BALANCED');
    });

    it('classifies WRITE_LEANING for 1 <= ratio < 3', () => {
      assert.strictEqual(classifyWorkload(1.0), 'WRITE_LEANING');
      assert.strictEqual(classifyWorkload(2.9), 'WRITE_LEANING');
    });

    it('classifies WRITE_HEAVY for ratio < 1', () => {
      assert.strictEqual(classifyWorkload(0.99), 'WRITE_HEAVY');
      assert.strictEqual(classifyWorkload(0.1), 'WRITE_HEAVY');
    });
  });

  describe('evaluateIndexingRisk', () => {
    it('flags HIGH risk for write-heavy tables (rwRatio < 1.0)', () => {
      const risk = evaluateIndexingRisk(0.6, 50, 20);
      assert.strictEqual(risk.level, 'HIGH');
      assert.strictEqual(risk.recommendation, 'AVOID_INDEXING_WRITE_HEAVY');
      assert.ok(risk.reason.includes('Write-heavy table'));
    });

    it('flags MEDIUM risk for high HOT efficiency tables (HOT >= 80% and rwRatio < 5.0)', () => {
      const risk = evaluateIndexingRisk(3.5, 92.5, 10);
      assert.strictEqual(risk.level, 'MEDIUM');
      assert.strictEqual(risk.recommendation, 'PRESERVE_HOT_UPDATES');
      assert.ok(risk.reason.includes('High HOT update efficiency'));
    });

    it('flags LOW risk with CONSIDER_INDEXING when seq scans are heavy and read ratio is healthy', () => {
      const risk = evaluateIndexingRisk(8.0, 40, 350);
      assert.strictEqual(risk.level, 'LOW');
      assert.strictEqual(risk.recommendation, 'CONSIDER_INDEXING');
      assert.ok(risk.reason.includes('heavy sequential scans'));
    });

    it('defaults to LOW risk MONITOR for balanced workloads', () => {
      const risk = evaluateIndexingRisk(4.0, 60, 10);
      assert.strictEqual(risk.level, 'LOW');
      assert.strictEqual(risk.recommendation, 'MONITOR');
    });
  });

  describe('harvestTableTelemetry', () => {
    it('queries pg_stat_user_tables and maps metrics into TableWorkloadProfile', async () => {
      const mockClient: PgClientLike = {
        query: async (sql: string, params?: unknown[]) => {
          assert.ok(sql.includes('pg_stat_user_tables'));
          assert.strictEqual(params?.[0], 'custom_schema');
          return {
            rows: [
              {
                schema_name: 'custom_schema',
                table_name: 'orders',
                seq_scan: '150',
                seq_tup_read: '15000',
                idx_scan: '3000',
                idx_tup_fetch: '45000',
                n_tup_ins: '2000',
                n_tup_upd: '3000',
                n_tup_del: '500',
                n_tup_hot_upd: '2550',
              },
            ],
          };
        },
      };

      const profiles = await harvestTableTelemetry(mockClient, { schema: 'custom_schema' });
      assert.strictEqual(profiles.length, 1);
      const p = profiles[0];
      assert.strictEqual(p.schemaName, 'custom_schema');
      assert.strictEqual(p.tableName, 'orders');
      assert.strictEqual(p.reads.seqScan, 150);
      assert.strictEqual(p.reads.idxScan, 3000);
      assert.strictEqual(p.writes.nTupIns, 2000);
      assert.strictEqual(p.writes.nHotUpd, 2550);
      // Total reads: 60000, Total writes: 5500 -> 10.91 ratio -> READ_HEAVY
      assert.strictEqual(p.readWriteRatio, 10.91);
      assert.strictEqual(p.hotEfficiencyPercent, 85.0);
      assert.strictEqual(p.workloadType, 'READ_HEAVY');
    });

    it('filters by specific table when specified in options', async () => {
      const mockClient: PgClientLike = {
        query: async (sql: string, params?: unknown[]) => {
          assert.ok(sql.includes('AND relname = $2'));
          assert.strictEqual(params?.[1], 'payments');
          return { rows: [] };
        },
      };

      const profiles = await harvestTableTelemetry(mockClient, { schema: 'public', table: 'payments' });
      assert.strictEqual(profiles.length, 0);
    });
  });

  describe('harvestQueryTelemetry', () => {
    it('returns empty and isAvailable=false when pg_stat_statements is not installed', async () => {
      const mockClient: PgClientLike = {
        query: async (sql: string) => {
          if (sql.includes('pg_extension')) {
            return { rows: [] };
          }
          throw new Error('should not query statement view');
        },
      };

      const res = await harvestQueryTelemetry(mockClient);
      assert.strictEqual(res.isAvailable, false);
      assert.strictEqual(res.queries.length, 0);
    });

    it('queries and parses pg_stat_statements when available', async () => {
      const mockClient: PgClientLike = {
        query: async (sql: string) => {
          if (sql.includes('pg_extension')) {
            return { rows: [{ '1': 1 }] };
          }
          if (sql.includes('pg_stat_statements')) {
            return {
              rows: [
                {
                  query_id: '987654321',
                  query: 'SELECT * FROM users WHERE email = $1',
                  calls: '500',
                  total_exec_time_ms: '12450.8',
                  mean_exec_time_ms: '24.9',
                  rows: '500',
                  shared_blks_read: '120',
                  shared_blks_hit: '4500',
                  temp_blks_written: '0',
                },
              ],
            };
          }
          return { rows: [] };
        },
      };

      const res = await harvestQueryTelemetry(mockClient, { limit: 5 });
      assert.strictEqual(res.isAvailable, true);
      assert.strictEqual(res.queries.length, 1);
      assert.strictEqual(res.queries[0].queryId, '987654321');
      assert.strictEqual(res.queries[0].totalExecTimeMs, 12450.8);
      assert.strictEqual(res.queries[0].meanExecTimeMs, 24.9);
      assert.strictEqual(res.queries[0].sharedBlksHit, 4500);
    });

    it('handles query failures gracefully by returning isAvailable=false', async () => {
      const mockClient: PgClientLike = {
        query: async (sql: string) => {
          if (sql.includes('pg_extension')) {
            return { rows: [{ '1': 1 }] };
          }
          throw new Error('permission denied for table pg_stat_statements');
        },
      };

      const res = await harvestQueryTelemetry(mockClient);
      assert.strictEqual(res.isAvailable, false);
      assert.strictEqual(res.queries.length, 0);
    });
  });

  describe('harvestFullWorkloadReport', () => {
    it('assembles full report combining tables and statements', async () => {
      const mockClient: PgClientLike = {
        query: async (sql: string) => {
          if (sql.includes('pg_stat_user_tables')) {
            return {
              rows: [
                {
                  schema_name: 'public',
                  table_name: 'logs',
                  seq_scan: '10',
                  seq_tup_read: '500',
                  idx_scan: '0',
                  idx_tup_fetch: '0',
                  n_tup_ins: '10000',
                  n_tup_upd: '0',
                  n_tup_del: '0',
                  n_tup_hot_upd: '0',
                },
              ],
            };
          }
          if (sql.includes('pg_extension')) {
            return { rows: [] };
          }
          return { rows: [] };
        },
      };

      const report = await harvestFullWorkloadReport(mockClient, { schema: 'public' });
      assert.strictEqual(report.tables.length, 1);
      assert.strictEqual(report.tables[0].tableName, 'logs');
      assert.strictEqual(report.tables[0].workloadType, 'WRITE_HEAVY');
      assert.strictEqual(report.hasPgStatStatements, false);
      assert.ok(report.checkedAt instanceof Date);
    });
  });

  describe('formatWorkloadReportTerminal', () => {
    it('formats empty report when no tables are present', () => {
      const report: WorkloadAnalysisReport = {
        tables: [],
        topSlowQueries: [],
        hasPgStatStatements: false,
        checkedAt: new Date('2026-09-19T12:00:00.000Z'),
      };

      const out = formatWorkloadReportTerminal(report);
      assert.ok(out.includes('ddlforge v1.9.0 — Autonomous Query Telemetry & Workload Analyzer'));
      assert.ok(out.includes('No tables found in specified schema.'));
    });

    it('formats complete report with table profiles and query telemetry', () => {
      const profile: TableWorkloadProfile = {
        schemaName: 'public',
        tableName: 'accounts',
        reads: { idxTupFetch: 1000, seqTupRead: 200, idxScan: 100, seqScan: 5 },
        writes: { nTupIns: 50, nTupUpd: 200, nTupDel: 10, nHotUpd: 180 },
        readWriteRatio: 4.62,
        hotEfficiencyPercent: 90.0,
        workloadType: 'BALANCED',
        indexingRisk: {
          level: 'MEDIUM',
          recommendation: 'PRESERVE_HOT_UPDATES',
          reason: 'High HOT update efficiency (90%). Adding indexes will cascade.',
        },
      };

      const report: WorkloadAnalysisReport = {
        tables: [profile],
        topSlowQueries: [
          {
            queryId: '12345',
            query: 'SELECT * FROM accounts WHERE status = ?',
            calls: 1000,
            totalExecTimeMs: 4500.5,
            meanExecTimeMs: 4.5,
            rows: 1000,
            sharedBlksRead: 50,
            sharedBlksHit: 950,
            tempBlksWritten: 0,
          },
        ],
        hasPgStatStatements: true,
        checkedAt: new Date('2026-09-19T12:00:00.000Z'),
      };

      const out = formatWorkloadReportTerminal(report);
      assert.ok(out.includes('Table: "public"."accounts" [BALANCED] [RISK: MEDIUM]'));
      assert.ok(out.includes('R/W Ratio:       4.62'));
      assert.ok(out.includes('HOT Efficiency:  90%'));
      assert.ok(out.includes('PRESERVE_HOT_UPDATES'));
      assert.ok(out.includes('TOP SLOW / I/O-HEAVY QUERIES (pg_stat_statements):'));
      assert.ok(out.includes('Query ID: 12345'));
    });
  });
});

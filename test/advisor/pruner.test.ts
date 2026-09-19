import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  isPrefixSubsumed,
  identifyRedundantIndexes,
  queryPrunableIndexes,
  formatPruneReportTerminal,
  RawIndexMetadata,
  PruneReport,
} from '../../src/advisor/pruner.js';
import type { PgClientLike } from '../../src/cluster/advisory.js';

describe('Unused & Redundant Index Pruning Engine (src/advisor/pruner.ts)', () => {
  describe('isPrefixSubsumed', () => {
    it('returns true when keysA is a strict prefix of keysB', () => {
      assert.strictEqual(isPrefixSubsumed(['user_id'], ['user_id', 'created_at']), true);
      assert.strictEqual(isPrefixSubsumed([1], [1, 2, 3]), true);
      assert.strictEqual(isPrefixSubsumed(['a', 'b'], ['a', 'b', 'c', 'd']), true);
    });

    it('returns false when keysA has equal or greater length than keysB', () => {
      assert.strictEqual(isPrefixSubsumed(['a', 'b'], ['a', 'b']), false);
      assert.strictEqual(isPrefixSubsumed(['a', 'b', 'c'], ['a', 'b']), false);
    });

    it('returns false when keysA does not match prefix of keysB', () => {
      assert.strictEqual(isPrefixSubsumed(['user_id'], ['account_id', 'created_at']), false);
      assert.strictEqual(isPrefixSubsumed(['a', 'c'], ['a', 'b', 'c']), false);
    });

    it('returns false when keysA is empty', () => {
      assert.strictEqual(isPrefixSubsumed([], ['user_id']), false);
    });
  });

  describe('identifyRedundantIndexes', () => {
    const createIndex = (overrides: Partial<RawIndexMetadata>): RawIndexMetadata => ({
      schemaName: 'public',
      tableName: 'orders',
      indexName: 'idx_sample',
      indexOid: 1000,
      tableOid: 2000,
      scans: 100,
      sizeBytes: 1048576, // 1 MB
      isValid: true,
      isUnique: false,
      isPrimary: false,
      keyColumns: ['1'],
      predicateExpr: null,
      isFkBacking: false,
      constraintType: null,
      ...overrides,
    });

    it('identifies redundant single-column index when composite index exists with matching prefix', () => {
      const idxA = createIndex({
        indexName: 'idx_orders_user_id',
        keyColumns: ['1'], // user_id
      });
      const idxB = createIndex({
        indexName: 'idx_orders_user_id_created',
        keyColumns: ['1', '2'], // user_id, created_at
      });

      const candidates = identifyRedundantIndexes([idxA, idxB]);
      assert.strictEqual(candidates.length, 1);
      assert.strictEqual(candidates[0].indexName, 'idx_orders_user_id');
      assert.strictEqual(candidates[0].subsumingIndex, 'idx_orders_user_id_created');
      assert.strictEqual(candidates[0].reason, 'REDUNDANT');
      assert.strictEqual(candidates[0].dropSql, 'DROP INDEX CONCURRENTLY IF EXISTS "public"."idx_orders_user_id";');
    });

    it('never prunes primary keys or unique constraints even if prefix is subsumed', () => {
      const pkIndex = createIndex({
        indexName: 'pk_orders',
        isPrimary: true,
        constraintType: 'p',
        keyColumns: ['1'],
      });
      const uniqueIndex = createIndex({
        indexName: 'uq_orders_user_id',
        isUnique: true,
        constraintType: 'u',
        keyColumns: ['1'],
      });
      const compositeIndex = createIndex({
        indexName: 'idx_orders_user_id_status',
        keyColumns: ['1', '2'],
      });

      const candidates = identifyRedundantIndexes([pkIndex, uniqueIndex, compositeIndex]);
      assert.strictEqual(candidates.length, 0);
    });

    it('does not flag index as redundant if partial index predicates differ', () => {
      const idxA = createIndex({
        indexName: 'idx_orders_user_id_active',
        keyColumns: ['1'],
        predicateExpr: '(status = 1)',
      });
      const idxB = createIndex({
        indexName: 'idx_orders_user_id_all',
        keyColumns: ['1', '2'],
        predicateExpr: null,
      });

      const candidates = identifyRedundantIndexes([idxA, idxB]);
      assert.strictEqual(candidates.length, 0);
    });

    it('flags foreign key backing index with safety warning', () => {
      const idxA = createIndex({
        indexName: 'idx_orders_fk_user',
        keyColumns: ['1'],
        isFkBacking: true,
      });
      const idxB = createIndex({
        indexName: 'idx_orders_fk_user_date',
        keyColumns: ['1', '2'],
      });

      const candidates = identifyRedundantIndexes([idxA, idxB]);
      assert.strictEqual(candidates.length, 1);
      assert.strictEqual(candidates[0].safetyWarnings.length, 1);
      assert.ok(candidates[0].safetyWarnings[0].includes('Foreign Key'));
    });
  });

  describe('queryPrunableIndexes', () => {
    it('detects invalid indexes, redundant indexes, and unused indexes', async () => {
      const mockClient: PgClientLike = {
        query: async (sql: string) => {
          if (sql.includes('stats_reset')) {
            return { rows: [{ stats_reset: '2026-09-01T00:00:00.000Z' }] };
          }
          if (sql.includes('pg_index')) {
            return {
              rows: [
                // 1. Invalid index remnant
                {
                  schema_name: 'public',
                  table_name: 'payments',
                  index_name: 'idx_payments_cc_failed',
                  index_oid: '1001',
                  table_oid: '2001',
                  scans: '0',
                  size_bytes: '52428800', // 50 MB
                  is_valid: false,
                  is_unique: false,
                  is_primary: false,
                  indkey_str: '1',
                  predicate_expr: null,
                  constraint_type: null,
                  is_fk_backing: false,
                },
                // 2. Redundant index: (1) subsumed by (1, 2)
                {
                  schema_name: 'public',
                  table_name: 'payments',
                  index_name: 'idx_payments_customer',
                  index_oid: '1002',
                  table_oid: '2001',
                  scans: '200',
                  size_bytes: '10485760', // 10 MB
                  is_valid: true,
                  is_unique: false,
                  is_primary: false,
                  indkey_str: '2',
                  predicate_expr: null,
                  constraint_type: null,
                  is_fk_backing: false,
                },
                {
                  schema_name: 'public',
                  table_name: 'payments',
                  index_name: 'idx_payments_customer_created',
                  index_oid: '1003',
                  table_oid: '2001',
                  scans: '5000',
                  size_bytes: '20971520', // 20 MB
                  is_valid: true,
                  is_unique: false,
                  is_primary: false,
                  indkey_str: '2 3',
                  predicate_expr: null,
                  constraint_type: null,
                  is_fk_backing: false,
                },
                // 3. Unused index with 0 scans
                {
                  schema_name: 'public',
                  table_name: 'payments',
                  index_name: 'idx_payments_obsolete_token',
                  index_oid: '1004',
                  table_oid: '2001',
                  scans: '0',
                  size_bytes: '15728640', // 15 MB
                  is_valid: true,
                  is_unique: false,
                  is_primary: false,
                  indkey_str: '4',
                  predicate_expr: null,
                  constraint_type: null,
                  is_fk_backing: false,
                },
                // 4. Primary key (should be excluded)
                {
                  schema_name: 'public',
                  table_name: 'payments',
                  index_name: 'pk_payments',
                  index_oid: '1005',
                  table_oid: '2001',
                  scans: '0',
                  size_bytes: '5242880',
                  is_valid: true,
                  is_unique: true,
                  is_primary: true,
                  indkey_str: '5',
                  predicate_expr: null,
                  constraint_type: 'p',
                  is_fk_backing: false,
                },
              ],
            };
          }
          return { rows: [] };
        },
      };

      const report = await queryPrunableIndexes(mockClient, { schema: 'public' });

      assert.strictEqual(report.candidates.length, 3);
      assert.strictEqual(report.invalidCount, 1);
      assert.strictEqual(report.redundantCount, 1);
      assert.strictEqual(report.unusedCount, 1);

      // Verify sizes: 50MB + 10MB + 15MB = 75 MB
      assert.strictEqual(report.totalReclaimableMb, 75.0);
      assert.strictEqual(report.statsResetDate?.toISOString(), '2026-09-01T00:00:00.000Z');

      const invalid = report.candidates.find(c => c.reason === 'INVALID');
      assert.strictEqual(invalid?.indexName, 'idx_payments_cc_failed');
      assert.strictEqual(invalid?.isSafeToDrop, true);

      const redundant = report.candidates.find(c => c.reason === 'REDUNDANT');
      assert.strictEqual(redundant?.indexName, 'idx_payments_customer');

      const unused = report.candidates.find(c => c.reason === 'UNUSED');
      assert.strictEqual(unused?.indexName, 'idx_payments_obsolete_token');
    });

    it('respects minSizeMb filter', async () => {
      const mockClient: PgClientLike = {
        query: async (sql: string) => {
          if (sql.includes('stats_reset')) return { rows: [] };
          return {
            rows: [
              {
                schema_name: 'public',
                table_name: 'audit',
                index_name: 'idx_tiny_unused',
                index_oid: '101',
                table_oid: '201',
                scans: '0',
                size_bytes: '1024', // 1 KB
                is_valid: true,
                is_unique: false,
                is_primary: false,
                indkey_str: '1',
                predicate_expr: null,
                constraint_type: null,
                is_fk_backing: false,
              },
            ],
          };
        },
      };

      // Filter minSizeMb = 10 -> 1 KB index should not be flagged as unused
      const report = await queryPrunableIndexes(mockClient, { minSizeMb: 10 });
      assert.strictEqual(report.candidates.length, 0);
    });

    it('flags caution and isSafeToDrop=false when unused index backs foreign key', async () => {
      const mockClient: PgClientLike = {
        query: async (sql: string) => {
          if (sql.includes('stats_reset')) return { rows: [] };
          return {
            rows: [
              {
                schema_name: 'public',
                table_name: 'items',
                index_name: 'idx_items_fk_order',
                index_oid: '301',
                table_oid: '401',
                scans: '0',
                size_bytes: '10485760',
                is_valid: true,
                is_unique: false,
                is_primary: false,
                indkey_str: '1',
                predicate_expr: null,
                constraint_type: null,
                is_fk_backing: true,
              },
            ],
          };
        },
      };

      const report = await queryPrunableIndexes(mockClient);
      assert.strictEqual(report.candidates.length, 1);
      assert.strictEqual(report.candidates[0].isSafeToDrop, false);
      assert.ok(report.candidates[0].safetyWarnings[0].includes('Foreign Key'));
    });
  });

  describe('formatPruneReportTerminal', () => {
    it('formats clean report when no prunable indexes found', () => {
      const report: PruneReport = {
        candidates: [],
        totalReclaimableBytes: 0,
        totalReclaimableMb: 0,
        unusedCount: 0,
        redundantCount: 0,
        invalidCount: 0,
        statsResetDate: new Date('2026-09-01T00:00:00.000Z'),
        checkedAt: new Date('2026-09-19T12:00:00.000Z'),
      };

      const out = formatPruneReportTerminal(report);
      assert.ok(out.includes('Index Lifecycle Advisor & Pruning Engine'));
      assert.ok(out.includes('All indexes are healthy, actively scanned, and non-redundant.'));
    });

    it('formats candidates with reasons, warnings, and concurrent drop statements', () => {
      const report: PruneReport = {
        candidates: [
          {
            schemaName: 'public',
            tableName: 'orders',
            indexName: 'idx_orders_status_old',
            reason: 'UNUSED',
            details: 'Index has recorded 0 scans since last stats reset.',
            sizeBytes: 52428800,
            scans: 0,
            isSafeToDrop: true,
            safetyWarnings: [],
            dropSql: 'DROP INDEX CONCURRENTLY IF EXISTS "public"."idx_orders_status_old";',
          },
          {
            schemaName: 'public',
            tableName: 'orders',
            indexName: 'idx_orders_user',
            reason: 'REDUNDANT',
            details: 'Column sequence (1) is fully subsumed by larger index "idx_orders_user_created".',
            subsumingIndex: 'idx_orders_user_created',
            sizeBytes: 20971520,
            scans: 10,
            isSafeToDrop: false,
            safetyWarnings: ['Index supports Foreign Key constraint.'],
            dropSql: 'DROP INDEX CONCURRENTLY IF EXISTS "public"."idx_orders_user";',
          },
        ],
        totalReclaimableBytes: 73400320,
        totalReclaimableMb: 70.0,
        unusedCount: 1,
        redundantCount: 1,
        invalidCount: 0,
        statsResetDate: null,
        checkedAt: new Date('2026-09-19T12:00:00.000Z'),
      };

      const out = formatPruneReportTerminal(report);
      assert.ok(out.includes('Total Candidates:       2 indexes'));
      assert.ok(out.includes('Total Reclaimable Disk: 70 MB'));
      assert.ok(out.includes('Index: "public"."idx_orders_status_old" on "orders" (50.00 MB) [UNUSED] [SAFE TO DROP]'));
      assert.ok(out.includes('Index: "public"."idx_orders_user" on "orders" (20.00 MB) [REDUNDANT] [CAUTION]'));
      assert.ok(out.includes('Superseded By:   "idx_orders_user_created"'));
      assert.ok(out.includes('⚠ Warning:       Index supports Foreign Key constraint.'));
      assert.ok(out.includes('DROP INDEX CONCURRENTLY IF EXISTS "public"."idx_orders_user";'));
    });
  });
});

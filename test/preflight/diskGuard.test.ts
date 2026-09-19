import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  estimateIndexSpace,
  estimateTableRewriteSpace,
  detectSharedMount,
  checkDiskHeadroom,
  formatBytes,
  auditDiskGuard,
} from '../../src/preflight/diskGuard.js';

describe('Pre-flight Disk & Mount Guard Engine', () => {
  describe('formatBytes', () => {
    it('formats bytes, KB, MB, and GB properly', () => {
      assert.strictEqual(formatBytes(500), '500 B');
      assert.strictEqual(formatBytes(1500), '1.5 KB');
      assert.strictEqual(formatBytes(10485760), '10.0 MB');
      assert.strictEqual(formatBytes(10737418240), '10.00 GB');
    });
  });

  describe('estimateIndexSpace', () => {
    it('uses safe tuple ceiling when n_live_tup + n_dead_tup exceeds reltuples', () => {
      const estimate = estimateIndexSpace({
        reltuples: 100000,
        nLiveTup: 200000,
        nDeadTup: 50000, // effective: 250000
        maintenanceWorkMemBytes: 128 * 1024 * 1024,
      });

      assert.strictEqual(estimate.effectiveTuples, 250000);
      assert.ok(estimate.estimatedIndexBytes > 0);
      assert.strictEqual(estimate.spillsToDisk, false);
      assert.ok(estimate.totalRequiredBytes > estimate.estimatedIndexBytes);
    });

    it('uses reltuples when it is higher than live+dead tuples', () => {
      const estimate = estimateIndexSpace({
        reltuples: 1000000,
        nLiveTup: 500000,
        nDeadTup: 100000,
      });

      assert.strictEqual(estimate.effectiveTuples, 1000000);
    });

    it('detects disk sort spills when sort data exceeds maintenance_work_mem', () => {
      const estimate = estimateIndexSpace({
        reltuples: 10000000, // 10M tuples * 32 bytes = 320 MB sort data
        maintenanceWorkMemBytes: 64 * 1024 * 1024, // 64 MB
      });

      assert.strictEqual(estimate.spillsToDisk, true);
      assert.ok(estimate.tempSortBytes > 0);
      assert.ok(estimate.totalRequiredBytes > estimate.tempSortBytes);
    });

    it('enforces safety multiplier within 1.5x - 2.0x range', () => {
      const estLow = estimateIndexSpace({ reltuples: 1000, safetyMultiplier: 1.1 });
      assert.strictEqual(estLow.safetyMultiplier, 1.5);

      const estHigh = estimateIndexSpace({ reltuples: 1000, safetyMultiplier: 2.5 });
      assert.strictEqual(estHigh.safetyMultiplier, 2.0);

      const estNorm = estimateIndexSpace({ reltuples: 1000, safetyMultiplier: 1.75 });
      assert.strictEqual(estNorm.safetyMultiplier, 1.75);
    });
  });

  describe('estimateTableRewriteSpace', () => {
    it('implements 2x heap + TOAST size validation', () => {
      const estimate = estimateTableRewriteSpace({
        heapBytes: 10 * 1024 * 1024 * 1024, // 10 GB
        toastBytes: 5 * 1024 * 1024 * 1024, // 5 GB
        indexesBytes: 3 * 1024 * 1024 * 1024, // 3 GB
      });

      // 2 * (10GB + 5GB) = 30 GB
      assert.strictEqual(estimate.transientTableBytes, 30 * 1024 * 1024 * 1024);
      assert.strictEqual(estimate.rebuiltIndexesBytes, 3 * 1024 * 1024 * 1024);
      assert.ok(estimate.walBytes > 0);
      assert.strictEqual(
        estimate.totalRequiredBytes,
        estimate.transientTableBytes + estimate.rebuiltIndexesBytes + estimate.walBytes
      );
    });
  });

  describe('detectSharedMount', () => {
    it('detects shared mount when pg_wal is default subfolder of data_directory', () => {
      const result = detectSharedMount('/var/lib/postgresql/data');
      assert.strictEqual(result.isSharedMount, true);
      assert.strictEqual(result.risk, 'HIGH');
      assert.ok(result.warning?.includes('Shared mount detected'));
    });

    it('detects shared mount when explicit walDirectory is inside data_directory', () => {
      const result = detectSharedMount('/var/lib/postgresql/data', '/var/lib/postgresql/data/pg_wal');
      assert.strictEqual(result.isSharedMount, true);
      assert.strictEqual(result.risk, 'HIGH');
    });

    it('detects isolated dedicated mount when walDirectory is on separate path', () => {
      const result = detectSharedMount('/var/lib/postgresql/data', '/mnt/nvme/pg_wal');
      assert.strictEqual(result.isSharedMount, false);
      assert.strictEqual(result.risk, 'LOW');
    });
  });

  describe('checkDiskHeadroom', () => {
    it('passes when disk space has ample headroom', () => {
      const report = checkDiskHeadroom(10 * 1024 * 1024 * 1024, 100 * 1024 * 1024 * 1024, 1.25);
      assert.strictEqual(report.hasSufficientSpace, true);
      assert.strictEqual(report.status, 'SAFE');
      assert.ok(report.projectedRemainingPercent > 80);
    });

    it('fails with CRITICAL when available space is less than required * multiplier', () => {
      const report = checkDiskHeadroom(10 * 1024 * 1024 * 1024, 11 * 1024 * 1024 * 1024, 1.25);
      assert.strictEqual(report.hasSufficientSpace, false);
      assert.strictEqual(report.status, 'CRITICAL');
      assert.ok(report.warning?.includes('Insufficient disk space'));
    });

    it('warns when projected remaining space drops below 15%', () => {
      // Required 75 GB with 1.1x = 82.5 GB. Available = 85 GB. Projected remaining = 10 GB (11.76% < 15%).
      const report = checkDiskHeadroom(75 * 1024 * 1024 * 1024, 85 * 1024 * 1024 * 1024, 1.1);
      assert.strictEqual(report.hasSufficientSpace, true);
      assert.strictEqual(report.status, 'WARNING');
      assert.ok(report.warning?.includes('Low disk headroom'));
    });
  });

  describe('auditDiskGuard with mock client', () => {
    it('queries catalog and generates complete disk report', async () => {
      const mockClient = {
        async query(sql: string) {
          if (sql.includes('pg_settings')) {
            return {
              rows: [
                { name: 'data_directory', setting: '/var/lib/postgresql/data' },
                { name: 'maintenance_work_mem', setting: '65536' },
                { name: 'wal_keep_size', setting: '1024' },
                { name: 'max_wal_size', setting: '1024' },
              ],
            };
          }
          if (sql.includes('pg_class')) {
            return {
              rows: [
                {
                  reltuples: '5000000',
                  n_live_tup: '5000000',
                  n_dead_tup: '500000',
                  heap_bytes: '1073741824',
                  toast_bytes: '0',
                  indexes_bytes: '268435456',
                },
              ],
            };
          }
          return { rows: [] };
        },
      };

      const report = await auditDiskGuard(mockClient, 'orders', {
        operation: 'create_index',
        availableBytes: 50 * 1024 * 1024 * 1024,
      });

      assert.strictEqual(report.table, 'orders');
      assert.strictEqual(report.operation, 'create_index');
      assert.strictEqual(report.sharedMount.isSharedMount, true);
      assert.ok(report.indexEstimate);
      assert.strictEqual(report.indexEstimate?.effectiveTuples, 5500000);
      assert.strictEqual(report.passed, true);
    });

    it('throws when table is not found in database', async () => {
      const mockClient = {
        async query(sql: string) {
          if (sql.includes('pg_settings')) {
            return { rows: [{ name: 'data_directory', setting: '/data' }] };
          }
          return { rows: [] }; // Table not found
        },
      };

      await assert.rejects(
        () => auditDiskGuard(mockClient, 'non_existent_table'),
        /not found in database catalog/
      );
    });
  });
});

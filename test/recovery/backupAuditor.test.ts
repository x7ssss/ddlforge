import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  parsePgBackRestJson,
  auditBackupRpo,
  assertRpoCompliance,
  detectHighRiskOperations,
  RpoViolationError,
  queryCatalogBackup,
  recordCatalogBackup,
} from '../../src/recovery/backupAuditor.js';

describe('Backup Recency Auditor & RPO Compliance (src/recovery/backupAuditor.ts)', () => {
  const baseTime = new Date('2026-09-19T12:00:00.000Z');

  describe('detectHighRiskOperations', () => {
    it('detects DROP TABLE as high risk', () => {
      const sql = 'DROP TABLE IF EXISTS old_users CASCADE;';
      const result = detectHighRiskOperations(sql);
      assert.strictEqual(result.isHighRisk, true);
      assert.match(result.reasons[0], /DROP TABLE statement detected/);
    });

    it('detects DROP COLUMN as high risk', () => {
      const sql = 'ALTER TABLE orders DROP COLUMN legacy_discount;';
      const result = detectHighRiskOperations(sql);
      assert.strictEqual(result.isHighRisk, true);
      assert.match(result.reasons[0], /DROP COLUMN statement detected/);
    });

    it('detects column TYPE rewrite as high risk', () => {
      const sql = 'ALTER TABLE accounts ALTER COLUMN balance TYPE numeric(18, 4);';
      const result = detectHighRiskOperations(sql);
      assert.strictEqual(result.isHighRisk, true);
      assert.match(result.reasons[0], /Column TYPE rewrite detected/);
    });

    it('detects TRUNCATE as high risk', () => {
      const sql = 'TRUNCATE audit_logs;';
      const result = detectHighRiskOperations(sql);
      assert.strictEqual(result.isHighRisk, true);
      assert.match(result.reasons[0], /TRUNCATE statement detected/);
    });

    it('detects DETACH PARTITION as high risk', () => {
      const sql = 'ALTER TABLE measurements DETACH PARTITION measurements_y2025m01;';
      const result = detectHighRiskOperations(sql);
      assert.strictEqual(result.isHighRisk, true);
      assert.match(result.reasons[0], /DETACH PARTITION statement detected/);
    });

    it('returns false for safe additive DDL operations', () => {
      const sql = `
        CREATE TABLE IF NOT EXISTS new_metrics (id serial primary key);
        ALTER TABLE users ADD COLUMN last_login_at timestamptz;
        CREATE INDEX CONCURRENTLY idx_users_last_login ON users (last_login_at);
      `;
      const result = detectHighRiskOperations(sql);
      assert.strictEqual(result.isHighRisk, false);
      assert.strictEqual(result.reasons.length, 0);
    });
  });

  describe('parsePgBackRestJson', () => {
    it('parses multi-stanza pgbackrest JSON and extracts the latest completed backup', () => {
      const stopTimeFull = Math.floor((baseTime.getTime() - 4 * 3600 * 1000) / 1000); // 4 hours before baseTime
      const stopTimeIncr = Math.floor((baseTime.getTime() - 2 * 3600 * 1000) / 1000); // 2 hours before baseTime

      const manifest = [
        {
          name: 'prod-cluster',
          status: { code: 0, message: 'ok' },
          backup: [
            {
              label: '20260919-080000F',
              type: 'full',
              timestamp: {
                start: 1726729200,
                stop: stopTimeFull,
              },
              info: { size: 53687091200, delta: 53687091200 },
              lsn: { start: '0/1000028', stop: '0/1000100' },
              error: false,
            },
            {
              label: '20260919-100000I',
              type: 'incr',
              timestamp: {
                start: 1726739000,
                stop: stopTimeIncr,
              },
              info: { size: 54760833024, delta: 1073741824 },
              lsn: { start: '0/1500028', stop: '0/1500100' },
              error: false,
            },
          ],
        },
      ];

      const backup = parsePgBackRestJson(manifest, baseTime);
      assert.ok(backup);
      assert.strictEqual(backup.backupId, '20260919-100000I');
      assert.strictEqual(backup.backupType, 'incr');
      assert.strictEqual(backup.provider, 'pgbackrest');
      assert.strictEqual(backup.status, 'completed');
      assert.strictEqual(backup.sizeBytes, 54760833024n);
      assert.strictEqual(backup.lsnStop, '0/1500100');
      assert.strictEqual(Math.round(backup.ageHours), 2);
    });

    it('ignores failed backups with error=true', () => {
      const manifest = [
        {
          name: 'staging',
          backup: [
            {
              label: '20260919-060000F',
              type: 'full',
              timestamp: { start: 1726720000, stop: 1726725000 },
              error: false,
            },
            {
              label: '20260919-110000I_failed',
              type: 'incr',
              timestamp: { start: 1726742000, stop: 1726745000 },
              error: true, // Errored backup must be skipped!
            },
          ],
        },
      ];

      const backup = parsePgBackRestJson(manifest, baseTime);
      assert.ok(backup);
      assert.strictEqual(backup.backupId, '20260919-060000F');
    });

    it('handles JSON string inputs', () => {
      const jsonStr = JSON.stringify([
        {
          name: 'demo',
          backup: [
            {
              label: '20260919-090000F',
              type: 'full',
              timestamp: { start: 1726735000, stop: 1726736400 },
              error: false,
            },
          ],
        },
      ]);

      const backup = parsePgBackRestJson(jsonStr, baseTime);
      assert.ok(backup);
      assert.strictEqual(backup.backupId, '20260919-090000F');
    });

    it('returns null when no valid backups exist', () => {
      const manifest = [{ name: 'empty', backup: [] }];
      const backup = parsePgBackRestJson(manifest, baseTime);
      assert.strictEqual(backup, null);
    });
  });

  describe('auditBackupRpo & assertRpoCompliance', () => {
    it('passes RPO compliance when backup age is within threshold', async () => {
      const report = await auditBackupRpo('mock', {
        now: baseTime,
        rpoHours: 24,
        mockAgeHours: 6, // 6 hours old < 24h limit
      });

      assert.strictEqual(report.isCompliant, true);
      assert.strictEqual(report.rpoHours, 24);
      assert.strictEqual(report.actualAgeHours, 6);
      assert.strictEqual(report.violationReason, undefined);

      // Should not throw
      assert.doesNotThrow(() => assertRpoCompliance(report));
    });

    it('fails RPO compliance and throws RpoViolationError when backup is stale', async () => {
      const report = await auditBackupRpo('mock', {
        now: baseTime,
        rpoHours: 24,
        mockAgeHours: 36, // 36 hours old > 24h limit!
      });

      assert.strictEqual(report.isCompliant, false);
      assert.strictEqual(report.actualAgeHours, 36);
      assert.match(report.violationReason!, /exceeding RPO limit of 24h/);

      assert.throws(
        () => assertRpoCompliance(report),
        (err: any) => {
          assert.ok(err instanceof RpoViolationError);
          assert.strictEqual(err.rpoHours, 24);
          assert.strictEqual(err.actualAgeHours, 36);
          assert.strictEqual(err.provider, 'mock');
          return true;
        }
      );
    });

    it('bypasses RpoViolationError when forceNoBackup is true', async () => {
      const report = await auditBackupRpo('mock', {
        now: baseTime,
        rpoHours: 24,
        mockAgeHours: 48,
      });

      assert.strictEqual(report.isCompliant, false);
      // When forceNoBackup is true, assertion passes without throwing
      assert.doesNotThrow(() => assertRpoCompliance(report, true));
    });

    it('fails when no backup exists at all', async () => {
      const report = await auditBackupRpo('pgbackrest', {
        now: baseTime,
        rpoHours: 24,
        pgbackrestJson: [],
      });

      assert.strictEqual(report.isCompliant, false);
      assert.strictEqual(report.latestBackup, null);
      assert.match(report.violationReason!, /No valid completed backup found/);
    });
  });

  describe('catalog provider (ddlforge.backup_catalog)', () => {
    it('queries and parses backup record from catalog table', async () => {
      const completedTime = new Date(baseTime.getTime() - 4 * 3600 * 1000); // 4 hours ago
      const mockClient = {
        async query(sql: string) {
          if (sql.includes('ddlforge.backup_catalog')) {
            return {
              rows: [
                {
                  backup_id: 'cat-backup-20260919',
                  provider: 'catalog',
                  backup_type: 'full',
                  status: 'completed',
                  started_at: new Date(completedTime.getTime() - 1800000).toISOString(),
                  completed_at: completedTime.toISOString(),
                  size_bytes: '10737418240',
                  lsn_stop: '0/16B3748',
                  metadata: { host: 'pg-prod-01' },
                },
              ],
            };
          }
          return { rows: [] };
        },
      };

      const record = await queryCatalogBackup(mockClient, baseTime);
      assert.ok(record);
      assert.strictEqual(record.backupId, 'cat-backup-20260919');
      assert.strictEqual(record.provider, 'catalog');
      assert.strictEqual(record.sizeBytes, 10737418240n);
      assert.strictEqual(record.ageHours, 4);

      const report = await auditBackupRpo('catalog', mockClient, { now: baseTime, rpoHours: 24 });
      assert.strictEqual(report.isCompliant, true);
      assert.strictEqual(report.actualAgeHours, 4);
    });

    it('records new completed backup into catalog table', async () => {
      let insertedSql = '';
      let insertedParams: any[] = [];
      const mockClient = {
        async query(sql: string, params?: unknown[]) {
          insertedSql = sql;
          insertedParams = params || [];
          return { rows: [] };
        },
      };

      await recordCatalogBackup(mockClient, {
        backupId: 'backup-test-101',
        provider: 'wal-g',
        backupType: 'diff',
        status: 'completed',
        startedAt: new Date('2026-09-19T08:00:00Z'),
        completedAt: new Date('2026-09-19T08:30:00Z'),
        sizeBytes: 2147483648n,
        lsnStop: '0/2000000',
        metadata: { engine: 'wal-g' },
      });

      assert.match(insertedSql, /INSERT INTO ddlforge\.backup_catalog/);
      assert.strictEqual(insertedParams[0], 'backup-test-101');
      assert.strictEqual(insertedParams[1], 'wal-g');
      assert.strictEqual(insertedParams[2], 'diff');
    });
  });
});

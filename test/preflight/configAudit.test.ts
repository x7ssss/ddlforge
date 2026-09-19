import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  auditSettings,
  evaluateCheckpointHealth,
  auditClusterConfig,
} from '../../src/preflight/configAudit.js';

describe('Pre-flight Static Configuration Risk Auditor & Checkpoint Telemetry', () => {
  describe('auditSettings', () => {
    it('detects CRITICAL risk when log_statement = all', () => {
      const risks = auditSettings({ log_statement: 'all' });
      const item = risks.find(r => r.setting === 'log_statement');
      assert.ok(item);
      assert.strictEqual(item?.severity, 'CRITICAL');
      assert.strictEqual(item?.ruleId, 'hazardous-log-statement-all');
    });

    it('detects CRITICAL risk when full_page_writes = off', () => {
      const risks = auditSettings({ full_page_writes: 'off' });
      const item = risks.find(r => r.setting === 'full_page_writes');
      assert.ok(item);
      assert.strictEqual(item?.severity, 'CRITICAL');
      assert.strictEqual(item?.ruleId, 'hazardous-full-page-writes-off');
    });

    it('detects HIGH risk when statement_timeout = 0', () => {
      const risks = auditSettings({ statement_timeout: '0' });
      const item = risks.find(r => r.setting === 'statement_timeout');
      assert.ok(item);
      assert.strictEqual(item?.severity, 'HIGH');
      assert.strictEqual(item?.ruleId, 'unbounded-statement-timeout');
    });

    it('detects HIGH risk when lock_timeout = 0', () => {
      const risks = auditSettings({ lock_timeout: '0ms' });
      const item = risks.find(r => r.setting === 'lock_timeout');
      assert.ok(item);
      assert.strictEqual(item?.severity, 'HIGH');
      assert.strictEqual(item?.ruleId, 'unbounded-lock-timeout');
    });

    it('detects HIGH risk when autovacuum = off', () => {
      const risks = auditSettings({ autovacuum: 'off' });
      const item = risks.find(r => r.setting === 'autovacuum');
      assert.ok(item);
      assert.strictEqual(item?.severity, 'HIGH');
      assert.strictEqual(item?.ruleId, 'hazardous-autovacuum-off');
    });

    it('detects MEDIUM risk when maintenance_work_mem is undersized (<64MB)', () => {
      const risks = auditSettings({ maintenance_work_mem: '16MB' });
      const item = risks.find(r => r.setting === 'maintenance_work_mem');
      assert.ok(item);
      assert.strictEqual(item?.severity, 'MEDIUM');
      assert.strictEqual(item?.ruleId, 'undersized-maintenance-work-mem');
    });

    it('passes cleanly with 0 risks when all settings are hardened', () => {
      const risks = auditSettings({
        log_statement: 'ddl',
        full_page_writes: 'on',
        statement_timeout: '30min',
        lock_timeout: '2s',
        autovacuum: 'on',
        maintenance_work_mem: '512MB',
      });
      assert.strictEqual(risks.length, 0);
    });
  });

  describe('evaluateCheckpointHealth', () => {
    it('routes to pg_stat_bgwriter on PG <= 16', () => {
      const health = evaluateCheckpointHealth({
        timed: 90,
        requested: 10,
        pgVersion: 16,
      });

      assert.strictEqual(health.pgVersion, 16);
      assert.strictEqual(health.sourceView, 'pg_stat_bgwriter');
      assert.strictEqual(health.totalCheckpoints, 100);
      assert.strictEqual(health.forcedPercentage, 10);
      assert.strictEqual(health.pressureLevel, 'LOW');
    });

    it('routes to pg_stat_checkpointer on PG >= 17', () => {
      const health = evaluateCheckpointHealth({
        timed: 50,
        requested: 50,
        pgVersion: 17,
      });

      assert.strictEqual(health.pgVersion, 17);
      assert.strictEqual(health.sourceView, 'pg_stat_checkpointer');
      assert.strictEqual(health.totalCheckpoints, 100);
      assert.strictEqual(health.forcedPercentage, 50);
      assert.strictEqual(health.pressureLevel, 'HIGH');
    });

    it('detects CRITICAL pressure when forced checkpoints exceed 50%', () => {
      const health = evaluateCheckpointHealth({
        timed: 20,
        requested: 80,
        pgVersion: 17,
      });

      assert.strictEqual(health.pressureLevel, 'CRITICAL');
      assert.ok(health.warning?.includes('Critical checkpoint pressure'));
      assert.ok(health.remediation?.includes('max_wal_size'));
    });
  });

  describe('auditClusterConfig with mock client', () => {
    it('executes version-aware queries against PG 16 and audits settings', async () => {
      const queriesExecuted: string[] = [];
      const mockClient = {
        async query(sql: string) {
          queriesExecuted.push(sql);
          if (sql.includes('server_version_num')) {
            return { rows: [{ server_version_num: '160002' }] };
          }
          if (sql.includes('pg_settings')) {
            return {
              rows: [
                { name: 'log_statement', setting: 'all' },
                { name: 'full_page_writes', setting: 'on' },
                { name: 'statement_timeout', setting: '0' },
                { name: 'lock_timeout', setting: '2s' },
                { name: 'autovacuum', setting: 'on' },
                { name: 'maintenance_work_mem', setting: '65536' },
              ],
            };
          }
          if (sql.includes('pg_stat_bgwriter')) {
            return { rows: [{ timed: '80', requested: '20' }] };
          }
          return { rows: [] };
        },
      };

      const report = await auditClusterConfig(mockClient);
      assert.strictEqual(report.hasCriticalRisks, true);
      assert.strictEqual(report.hasHighRisks, true);
      assert.strictEqual(report.passed, false);
      assert.ok(queriesExecuted.some(q => q.includes('pg_stat_bgwriter')));
    });

    it('executes version-aware queries against PG 17', async () => {
      const queriesExecuted: string[] = [];
      const mockClient = {
        async query(sql: string) {
          queriesExecuted.push(sql);
          if (sql.includes('server_version_num')) {
            return { rows: [{ server_version_num: '170001' }] };
          }
          if (sql.includes('pg_settings')) {
            return {
              rows: [
                { name: 'log_statement', setting: 'ddl' },
                { name: 'full_page_writes', setting: 'on' },
                { name: 'statement_timeout', setting: '10min' },
                { name: 'lock_timeout', setting: '2s' },
                { name: 'autovacuum', setting: 'on' },
                { name: 'maintenance_work_mem', setting: '524288' },
              ],
            };
          }
          if (sql.includes('pg_stat_checkpointer')) {
            return { rows: [{ timed: '95', requested: '5' }] };
          }
          return { rows: [] };
        },
      };

      const report = await auditClusterConfig(mockClient);
      assert.strictEqual(report.hasCriticalRisks, false);
      assert.strictEqual(report.hasHighRisks, false);
      assert.strictEqual(report.passed, true);
      assert.ok(queriesExecuted.some(q => q.includes('pg_stat_checkpointer')));
    });
  });
});

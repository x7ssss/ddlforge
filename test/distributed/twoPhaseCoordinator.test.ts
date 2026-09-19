import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  normalizeDdl,
  calculateDdlChecksum,
  getBootstrapLedgerSql,
  prepareDistributedRun,
  commitDistributedRun,
  abortDistributedRun,
  sweepDistributedRuns,
  formatSweepReportTerminal,
} from '../../src/distributed/twoPhaseCoordinator.js';

describe('Distributed DDL State Machine & Two-Phase Coordinator (src/distributed/twoPhaseCoordinator.ts)', () => {
  describe('normalizeDdl & calculateDdlChecksum', () => {
    it('normalizes comments and whitespace deterministically', () => {
      const sql1 = `
        -- Adding index for tenant performance
        CREATE INDEX CONCURRENTLY idx_users_email
        /* Multi-line comment
           spanning lines */
        ON users (email);
      `;
      const sql2 = `CREATE INDEX CONCURRENTLY idx_users_email ON users (email);`;

      assert.strictEqual(normalizeDdl(sql1), normalizeDdl(sql2));
      assert.strictEqual(calculateDdlChecksum(sql1), calculateDdlChecksum(sql2));
    });

    it('generates different checksums for different DDL statements', () => {
      const ddlA = 'ALTER TABLE users ADD COLUMN age INT;';
      const ddlB = 'ALTER TABLE users ADD COLUMN age BIGINT;';

      assert.notStrictEqual(calculateDdlChecksum(ddlA), calculateDdlChecksum(ddlB));
    });
  });

  describe('getBootstrapLedgerSql', () => {
    it('emits schema and table DDL for state ledger', () => {
      const sql = getBootstrapLedgerSql();
      assert.ok(sql.includes('CREATE SCHEMA IF NOT EXISTS ddlforge;'));
      assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS ddlforge.ddlforge_distributed_run'));
      assert.ok(sql.includes('phase VARCHAR(16) NOT NULL'));
      assert.ok(sql.includes('checksum VARCHAR(64) NOT NULL'));
      assert.ok(sql.includes('PRIMARY KEY (run_id, node_id)'));
    });
  });

  describe('Ledger state transitions: prepare, commit, abort', () => {
    it('prepares distributed run record in ledger', async () => {
      const queries: { sql: string; params?: unknown[] }[] = [];
      const mockClient = {
        async query(sql: string, params?: unknown[]) {
          queries.push({ sql, params });
          return { rows: [] };
        },
      };

      const record = await prepareDistributedRun(mockClient, {
        runId: 'run_123',
        migrationVersion: '001_init.sql',
        nodeId: 'tenant_alpha',
        ddlStatement: 'CREATE TABLE orders (id BIGINT PRIMARY KEY);',
      });

      assert.strictEqual(record.runId, 'run_123');
      assert.strictEqual(record.nodeId, 'tenant_alpha');
      assert.strictEqual(record.phase, 'PREPARED');
      assert.strictEqual(record.retryCount, 0);
      assert.ok(record.checksum.length === 64);
      assert.ok(queries.some(q => q.sql.includes('INSERT INTO ddlforge.ddlforge_distributed_run')));
    });

    it('commits distributed run record', async () => {
      const queries: { sql: string; params?: unknown[] }[] = [];
      const mockClient = {
        async query(sql: string, params?: unknown[]) {
          queries.push({ sql, params });
          return { rows: [] };
        },
      };

      await commitDistributedRun(mockClient, {
        runId: 'run_123',
        nodeId: 'tenant_alpha',
        metadata: { durationMs: 45 },
      });

      assert.ok(queries.some(q => q.sql.includes("SET phase = 'COMMITTED'")));
    });

    it('aborts distributed run record with error message and retry count increment', async () => {
      const queries: { sql: string; params?: unknown[] }[] = [];
      const mockClient = {
        async query(sql: string, params?: unknown[]) {
          queries.push({ sql, params });
          return { rows: [] };
        },
      };

      await abortDistributedRun(mockClient, {
        runId: 'run_123',
        nodeId: 'tenant_alpha',
        error: 'Exclusive lock acquisition timed out after 2s',
      });

      assert.ok(queries.some(q => q.sql.includes("SET phase = 'ABORTED'") && q.sql.includes('retry_count = retry_count + 1')));
    });
  });

  describe('sweepDistributedRuns (Self-Healing Consensus Sweeper)', () => {
    it('heals lagging PREPARED node when majority of fleet COMMITTED', async () => {
      const executedUpdates: string[] = [];
      const mockClient = {
        async query(sql: string, params?: unknown[]) {
          if (sql.includes('SELECT') && sql.includes("phase = 'PREPARED'") && sql.includes('prepared_at < NOW()')) {
            // Return 1 stale prepared run on tenant_3
            return {
              rows: [
                {
                  run_id: 'run_consensus_test',
                  migration_version: '002_add_index.sql',
                  node_id: 'tenant_3',
                  phase: 'PREPARED',
                },
              ],
            };
          }
          if (sql.includes('SELECT node_id, phase') && sql.includes('WHERE run_id = $1')) {
            // Fleet has 3 nodes: tenant_1 and tenant_2 are COMMITTED (majority!)
            return {
              rows: [
                { node_id: 'tenant_1', phase: 'COMMITTED' },
                { node_id: 'tenant_2', phase: 'COMMITTED' },
                { node_id: 'tenant_3', phase: 'PREPARED' },
              ],
            };
          }
          if (sql.includes('UPDATE')) {
            executedUpdates.push(sql);
          }
          return { rows: [] };
        },
      };

      const report = await sweepDistributedRuns(mockClient, {
        maxAgeMinutes: 30,
        autoHeal: true,
      });

      assert.strictEqual(report.staleCount, 1);
      assert.strictEqual(report.healedCount, 1);
      assert.strictEqual(report.abortedCount, 0);
      assert.strictEqual(report.actions[0].toPhase, 'HEALED');
      assert.ok(report.actions[0].reason.includes('Fleet consensus achieved'));
      assert.ok(executedUpdates.some(u => u.includes("SET phase = 'HEALED'")));
    });

    it('aborts abandoned run when majority consensus was not achieved', async () => {
      const executedUpdates: string[] = [];
      const mockClient = {
        async query(sql: string, params?: unknown[]) {
          if (sql.includes('SELECT') && sql.includes("phase = 'PREPARED'") && sql.includes('prepared_at < NOW()')) {
            return {
              rows: [
                {
                  run_id: 'run_abandoned_test',
                  migration_version: '003_failed_ddl.sql',
                  node_id: 'tenant_1',
                  phase: 'PREPARED',
                },
              ],
            };
          }
          if (sql.includes('SELECT node_id, phase') && sql.includes('WHERE run_id = $1')) {
            // Only 0 out of 3 committed
            return {
              rows: [
                { node_id: 'tenant_1', phase: 'PREPARED' },
                { node_id: 'tenant_2', phase: 'ABORTED' },
                { node_id: 'tenant_3', phase: 'ABORTED' },
              ],
            };
          }
          if (sql.includes('UPDATE')) {
            executedUpdates.push(sql);
          }
          return { rows: [] };
        },
      };

      const report = await sweepDistributedRuns(mockClient, {
        maxAgeMinutes: 15,
        autoHeal: true,
      });

      assert.strictEqual(report.staleCount, 1);
      assert.strictEqual(report.healedCount, 0);
      assert.strictEqual(report.abortedCount, 1);
      assert.strictEqual(report.actions[0].toPhase, 'ABORTED');
      assert.ok(report.actions[0].reason.includes('Fleet consensus failed'));
      assert.ok(executedUpdates.some(u => u.includes("SET phase = 'ABORTED'")));
    });
  });

  describe('formatSweepReportTerminal', () => {
    it('formats healthy report when no orphans exist', () => {
      const report = {
        inspectedRuns: 0,
        staleCount: 0,
        healedCount: 0,
        abortedCount: 0,
        actions: [],
        checkedAt: new Date('2026-09-19T12:00:00.000Z'),
      };

      const output = formatSweepReportTerminal(report);
      assert.ok(output.includes('Distributed DDL Orphan Sweeper Report'));
      assert.ok(output.includes('All distributed runs are healthy'));
    });

    it('formats actionable report with transition details', () => {
      const report = {
        inspectedRuns: 2,
        staleCount: 2,
        healedCount: 1,
        abortedCount: 1,
        actions: [
          {
            runId: 'run_101',
            nodeId: 'tenant_eu',
            migrationVersion: '005_idx.sql',
            fromPhase: 'PREPARED' as const,
            toPhase: 'HEALED' as const,
            reason: 'Consensus achieved (2/3 nodes committed)',
          },
          {
            runId: 'run_102',
            nodeId: 'tenant_ap',
            migrationVersion: '006_drop.sql',
            fromPhase: 'PREPARED' as const,
            toPhase: 'ABORTED' as const,
            reason: 'Consensus failed (0/3 nodes committed)',
          },
        ],
        checkedAt: new Date('2026-09-19T12:00:00.000Z'),
      };

      const output = formatSweepReportTerminal(report);
      assert.ok(output.includes('PREPARED -> HEALED'));
      assert.ok(output.includes('PREPARED -> ABORTED'));
      assert.ok(output.includes('tenant_eu'));
      assert.ok(output.includes('tenant_ap'));
    });
  });
});

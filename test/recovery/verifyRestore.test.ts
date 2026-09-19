import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  verifyRecoveryCompletion,
  verifyBtreeIndexes,
  queryUnvalidatedForeignKeys,
  verifyRestoredInstance,
  formatRestoreReportTerminal,
} from '../../src/recovery/verifyRestore.js';
import {
  recordSafetyLog,
  querySafetyLog,
  ensureSafetyLedgerTable,
} from '../../src/recovery/safetyLedger.js';

describe('Restore Verification Hook & Instance Health (src/recovery/verifyRestore.ts)', () => {
  const baseTime = new Date('2026-09-19T12:00:00.000Z');

  describe('verifyRecoveryCompletion', () => {
    it('returns recoveryCompleted=true when pg_is_in_recovery() is false', async () => {
      const mockClient = {
        async query() {
          return { rows: [{ in_recovery: false }] };
        },
      };

      const result = await verifyRecoveryCompletion(mockClient);
      assert.strictEqual(result.recoveryCompleted, true);
      assert.strictEqual(result.isInRecovery, false);
    });

    it('returns recoveryCompleted=false when database is still in recovery', async () => {
      const mockClient = {
        async query() {
          return { rows: [{ in_recovery: true }] };
        },
      };

      const result = await verifyRecoveryCompletion(mockClient);
      assert.strictEqual(result.recoveryCompleted, false);
      assert.strictEqual(result.isInRecovery, true);
    });
  });

  describe('verifyBtreeIndexes (amcheck / bt_index_check)', () => {
    it('skips amcheck validation when skipAmcheck option is true', async () => {
      const mockClient = {
        async query() {
          throw new Error('Should not be called when skipped');
        },
      };

      const result = await verifyBtreeIndexes(mockClient, { skipAmcheck: true });
      assert.strictEqual(result.skipped, true);
      assert.strictEqual(result.passed, true);
      assert.strictEqual(result.totalIndexesChecked, 0);
    });

    it('detects clean indexes when bt_index_check succeeds', async () => {
      const mockClient = {
        async query(sql: string) {
          if (sql.includes("extname = 'amcheck'")) {
            return { rows: [{ '1': 1 }] }; // extension present
          }
          if (sql.includes("am.amname = 'btree'")) {
            return {
              rows: [
                { index_oid: 16400, index_name: 'users_pkey', schema_name: 'public', table_name: 'users' },
                { index_oid: 16401, index_name: 'idx_users_email', schema_name: 'public', table_name: 'users' },
              ],
            };
          }
          if (sql.includes('bt_index_check')) {
            return { rows: [] }; // Success, no error
          }
          return { rows: [] };
        },
      };

      const result = await verifyBtreeIndexes(mockClient);
      assert.strictEqual(result.passed, true);
      assert.strictEqual(result.totalIndexesChecked, 2);
      assert.strictEqual(result.corruptedIndexes.length, 0);
      assert.match(result.message!, /Verified 2 B-tree index\(es\) cleanly/);
    });

    it('catches and reports corrupted index exceptions thrown by bt_index_check', async () => {
      const mockClient = {
        async query(sql: string, params?: unknown[]) {
          if (sql.includes("extname = 'amcheck'")) {
            return { rows: [{ '1': 1 }] };
          }
          if (sql.includes("am.amname = 'btree'")) {
            return {
              rows: [
                { index_oid: 16400, index_name: 'users_pkey', schema_name: 'public', table_name: 'users' },
                { index_oid: 16401, index_name: 'idx_orders_corrupt', schema_name: 'public', table_name: 'orders' },
              ],
            };
          }
          if (sql.includes('bt_index_check')) {
            if (params && params[0] === 16401) {
              throw new Error('item order invariant violated for index "idx_orders_corrupt"');
            }
            return { rows: [] };
          }
          return { rows: [] };
        },
      };

      const result = await verifyBtreeIndexes(mockClient);
      assert.strictEqual(result.passed, false);
      assert.strictEqual(result.corruptedIndexes.length, 1);
      assert.strictEqual(result.corruptedIndexes[0].indexName, 'idx_orders_corrupt');
      assert.match(result.corruptedIndexes[0].error, /item order invariant violated/);
    });
  });

  describe('queryUnvalidatedForeignKeys', () => {
    it('discovers foreign keys with convalidated = false', async () => {
      const mockClient = {
        async query() {
          return {
            rows: [
              {
                constraint_name: 'fk_orders_user_id',
                schema_name: 'public',
                table_name: 'orders',
                foreign_table_name: 'users',
                definition: 'FOREIGN KEY (user_id) REFERENCES users(id) NOT VALID',
              },
            ],
          };
        },
      };

      const fks = await queryUnvalidatedForeignKeys(mockClient);
      assert.strictEqual(fks.length, 1);
      assert.strictEqual(fks[0].constraintName, 'fk_orders_user_id');
      assert.strictEqual(fks[0].tableName, 'orders');
      assert.strictEqual(fks[0].foreignTableName, 'users');
    });

    it('returns empty array when all foreign keys are valid', async () => {
      const mockClient = {
        async query() {
          return { rows: [] };
        },
      };

      const fks = await queryUnvalidatedForeignKeys(mockClient);
      assert.strictEqual(fks.length, 0);
    });
  });

  describe('verifyRestoredInstance end-to-end', () => {
    it('runs comprehensive checks and passes for healthy restored instance', async () => {
      const mockClient = {
        async query(sql: string) {
          if (sql.includes('pg_is_in_recovery()')) {
            return { rows: [{ in_recovery: false }] };
          }
          if (sql.includes("extname = 'amcheck'")) {
            return { rows: [{ '1': 1 }] };
          }
          if (sql.includes("am.amname = 'btree'")) {
            return {
              rows: [
                { index_oid: 10, index_name: 'users_pkey', schema_name: 'public', table_name: 'users' },
              ],
            };
          }
          if (sql.includes('bt_index_check')) {
            return { rows: [] };
          }
          if (sql.includes('convalidated')) {
            return { rows: [] }; // No unvalidated FKs
          }
          if (sql.includes('INSERT INTO ddlforge.migration_safety_log')) {
            return { rows: [{ id: 42 }] };
          }
          return { rows: [] };
        },
      };

      const report = await verifyRestoredInstance(mockClient, {
        targetUrl: 'postgres://postgres:secret@localhost:5432/restored_db',
        now: baseTime,
      });

      assert.strictEqual(report.passed, true);
      assert.strictEqual(report.recoveryCompleted, true);
      assert.strictEqual(report.amcheck.passed, true);
      assert.strictEqual(report.foreignKeys.passed, true);
      assert.strictEqual(report.ledgerLogged, true);
      assert.strictEqual(report.errors.length, 0);
      assert.strictEqual(report.warnings.length, 0);

      const terminal = formatRestoreReportTerminal(report);
      assert.match(terminal, /RESTORE VERIFICATION PASSED/);
      assert.match(terminal, /Recovery completed/);
    });

    it('reports failure when instance is still in recovery or corrupted', async () => {
      const mockClient = {
        async query(sql: string) {
          if (sql.includes('pg_is_in_recovery()')) {
            return { rows: [{ in_recovery: true }] }; // Still in recovery!
          }
          if (sql.includes("extname = 'amcheck'")) {
            return { rows: [] };
          }
          if (sql.includes('convalidated')) {
            return {
              rows: [
                {
                  constraint_name: 'fk_test',
                  schema_name: 'public',
                  table_name: 'items',
                  foreign_table_name: 'categories',
                  definition: 'FOREIGN KEY (cat_id) REFERENCES categories(id) NOT VALID',
                },
              ],
            };
          }
          return { rows: [] };
        },
      };

      const report = await verifyRestoredInstance(mockClient, {
        targetUrl: 'postgres://localhost:5432/standby_replica',
        now: baseTime,
      });

      assert.strictEqual(report.passed, false);
      assert.strictEqual(report.recoveryCompleted, false);
      assert.strictEqual(report.errors.length >= 1, true);
      assert.match(report.errors[0], /Database is currently in recovery mode/);
      assert.strictEqual(report.warnings.length, 1);
      assert.match(report.warnings[0], /unvalidated foreign key constraint/);

      const terminal = formatRestoreReportTerminal(report);
      assert.match(terminal, /RESTORE VERIFICATION FAILED/);
    });
  });

  describe('Migration Safety Ledger (safetyLedger.ts)', () => {
    it('ensures safety ledger table and inserts verification audit entries', async () => {
      let createdTable = false;
      let insertedLog: any = null;

      const mockClient = {
        async query(sql: string, params?: unknown[]) {
          if (sql.includes('CREATE TABLE IF NOT EXISTS ddlforge.migration_safety_log')) {
            createdTable = true;
            return { rows: [] };
          }
          if (sql.includes('INSERT INTO ddlforge.migration_safety_log')) {
            insertedLog = { sql, params };
            return { rows: [{ id: 99 }] };
          }
          return { rows: [] };
        },
      };

      await ensureSafetyLedgerTable(mockClient);
      assert.strictEqual(createdTable, true);

      const id = await recordSafetyLog(mockClient, {
        eventType: 'doctor_check',
        targetIdentifier: 'localhost:5432/prod_db',
        status: 'PASSED',
        details: { healthy: true },
      });

      assert.strictEqual(id, 99);
      assert.strictEqual(insertedLog.params[0], 'doctor_check');
      assert.strictEqual(insertedLog.params[1], 'localhost:5432/prod_db');
      assert.strictEqual(insertedLog.params[2], 'PASSED');
    });

    it('queries safety log entries with limit and filters', async () => {
      const mockClient = {
        async query(sql: string, params?: unknown[]) {
          return {
            rows: [
              {
                id: 1,
                event_type: 'doctor_check',
                target_identifier: 'localhost:5432/prod',
                status: 'PASSED',
                details: JSON.stringify({ ok: true }),
                created_at: baseTime.toISOString(),
              },
            ],
          };
        },
      };

      const logs = await querySafetyLog(mockClient, { limit: 5, eventType: 'doctor_check' });
      assert.strictEqual(logs.length, 1);
      assert.strictEqual(logs[0].id, 1);
      assert.strictEqual(logs[0].eventType, 'doctor_check');
      assert.deepStrictEqual(logs[0].details, { ok: true });
    });
  });
});

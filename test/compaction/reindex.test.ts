import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  generateReindexScript,
  validateReindexTransactionContext,
} from '../../src/compaction/reindex.js';

describe('Lock-Safe Index Reindexer (src/compaction/reindex.ts)', () => {
  describe('generateReindexScript', () => {
    it('throws error when table is empty', () => {
      assert.throws(
        () => generateReindexScript({ table: '' }),
        /generateReindexScript: table name is required/
      );
    });

    it('generates REINDEX INDEX CONCURRENTLY when index name is provided', () => {
      const res = generateReindexScript({
        table: 'orders',
        index: 'idx_orders_customer_id',
        schema: 'public',
      });

      assert.strictEqual(res.targetType, 'index');
      assert.strictEqual(res.targetIdentifier, '"public"."idx_orders_customer_id"');
      assert.strictEqual(res.sql, 'REINDEX INDEX CONCURRENTLY "public"."idx_orders_customer_id";');
      assert.strictEqual(res.requiresAutocommit, true);
      assert.ok(res.explanation.includes('ShareUpdateExclusiveLock'));
      assert.ok(res.explanation.includes('autocommit mode'));
    });

    it('generates REINDEX TABLE CONCURRENTLY when index name is omitted', () => {
      const res = generateReindexScript({
        table: 'users',
        schema: 'auth',
      });

      assert.strictEqual(res.targetType, 'table');
      assert.strictEqual(res.targetIdentifier, '"auth"."users"');
      assert.strictEqual(res.sql, 'REINDEX TABLE CONCURRENTLY "auth"."users";');
      assert.strictEqual(res.requiresAutocommit, true);
    });
  });

  describe('validateReindexTransactionContext', () => {
    it('rejects execution inside an active transaction block (SQLSTATE 55000)', () => {
      const check = validateReindexTransactionContext(true);
      assert.strictEqual(check.isValid, false);
      assert.ok(check.errorMessage?.includes('SQLSTATE 55000'));
      assert.ok(check.errorMessage?.includes('cannot run inside a transaction block'));
    });

    it('approves execution in autocommit context outside a transaction block', () => {
      const check = validateReindexTransactionContext(false);
      assert.strictEqual(check.isValid, true);
      assert.strictEqual(check.errorMessage, undefined);
    });
  });
});

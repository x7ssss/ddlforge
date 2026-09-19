/**
 * ddlforge — test/masking/backfill.test.ts
 *
 * Unit tests for keyset backfill masking procedure generator:
 *   - Keyset pagination with FOR UPDATE SKIP LOCKED
 *   - Bounded lock timeout and exponential backoff
 *   - Per-batch transaction loop COMMITs
 *   - Deferred foreign key constraints (SET CONSTRAINTS ALL DEFERRED)
 *   - Multi-column deterministic updates
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateMaskingBackfill } from '../../src/masking/backfill.js';

describe('generateMaskingBackfill()', () => {
  it('generates a keyset-paginated stored procedure for single column masking', () => {
    const res = generateMaskingBackfill({
      table: 'users',
      columns: ['email:email'],
      primaryKey: 'user_id',
      batchSize: 1000,
    });

    assert.strictEqual(res.procedureName, 'sp_mask_backfill_users');
    assert.ok(res.procedureSql.includes('CREATE OR REPLACE PROCEDURE "public"."sp_mask_backfill_users"'));
    assert.ok(res.procedureSql.includes('p_batch_size INT DEFAULT 1000'));

    // Keyset pagination queries
    assert.ok(res.procedureSql.includes('ORDER BY "user_id" ASC'));
    assert.ok(res.procedureSql.includes('LIMIT p_batch_size'));
    assert.ok(res.procedureSql.includes('FOR UPDATE SKIP LOCKED'));
    assert.ok(res.procedureSql.includes('"user_id" > v_last_id'));

    // In-line masking update
    assert.ok(res.procedureSql.includes('"email_masked" = _ddlforge_mask_email("email", \'email\')'));
    assert.ok(res.procedureSql.includes('WHERE "user_id" = ANY(v_batch_ids);'));

    // Lock timeout and commit
    assert.ok(res.procedureSql.includes("EXECUTE 'SET LOCAL lock_timeout = ''2s'''"));
    assert.ok(res.procedureSql.includes('COMMIT;'));
    assert.ok(res.procedureSql.includes('PERFORM pg_sleep(0.05 + random() * 0.05);'));
  });

  it('supports multiple columns across diverse masking types', () => {
    const res = generateMaskingBackfill({
      table: 'customers',
      columns: ['email:email', 'ssn:text', 'account_id:integer', 'tenant_id:uuid'],
    });

    assert.ok(res.procedureSql.includes('"email_masked" = _ddlforge_mask_email("email", \'email\')'));
    assert.ok(res.procedureSql.includes('"ssn_masked" = _ddlforge_hmac_token("ssn", \'ssn\')'));
    assert.ok(res.procedureSql.includes('"account_id_masked" = feistel_encrypt_integer("account_id")'));
    assert.ok(res.procedureSql.includes('"tenant_id_masked" = _ddlforge_mask_uuid("tenant_id", \'tenant_id\')'));
  });

  it('includes SET CONSTRAINTS ALL DEFERRED when deferConstraints is enabled', () => {
    const res = generateMaskingBackfill({
      table: 'orders',
      columns: ['total:integer'],
      deferConstraints: true,
    });
    assert.ok(res.procedureSql.includes('SET CONSTRAINTS ALL DEFERRED;'));
  });

  it('omits SET CONSTRAINTS ALL DEFERRED when deferConstraints is false', () => {
    const res = generateMaskingBackfill({
      table: 'orders',
      columns: ['total:integer'],
      deferConstraints: false,
    });
    assert.ok(!res.procedureSql.includes('SET CONSTRAINTS ALL DEFERRED;'));
  });

  it('generates invocation SQL with correct procedure name and batch size', () => {
    const res = generateMaskingBackfill({
      table: 'payments',
      columns: ['card_number:text'],
      batchSize: 5000,
    });
    assert.strictEqual(res.callSql, 'CALL "public"."sp_mask_backfill_payments"(5000);');
  });

  it('throws error when no columns provided', () => {
    assert.throws(() => {
      generateMaskingBackfill({
        table: 'empty',
        columns: [],
      });
    }, /At least one column must be specified/);
  });
});

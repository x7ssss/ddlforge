/**
 * ddlforge - Resumable Keyset Backfill Procedure Tests
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { generateBackfillProcedure } from '../../src/orchestrator/backfill.js';

describe('Backfill: generateBackfillProcedure', () => {
  it('generates stored procedure with keyset pagination over CTID', () => {
    const res = generateBackfillProcedure({
      table: 'users',
      fromColumn: 'name',
      toColumn: 'full_name',
      primaryKey: 'id',
      batchSize: 2000,
    });

    // Keyset pagination verification
    assert.ok(res.procedureSql.includes('v_last_id BIGINT := NULL;'));
    assert.ok(res.procedureSql.includes('WHERE "id" > v_last_id'));
    assert.ok(res.procedureSql.includes('ORDER BY "id" ASC'));
    assert.ok(res.procedureSql.includes('LIMIT p_batch_size'));
    assert.ok(res.procedureSql.includes('FOR UPDATE SKIP LOCKED'));

    // Verify CTID is NOT used for cursor
    assert.ok(!res.procedureSql.includes('WHERE ctid >'));
    assert.ok(!res.procedureSql.includes('ORDER BY ctid'));
  });

  it('includes loop COMMIT statements to flush WAL and release locks', () => {
    const res = generateBackfillProcedure({
      table: 'orders',
      fromColumn: 'total_cents',
      toColumn: 'total_dollars',
      transformExpression: '"total_cents" / 100.0',
    });

    assert.ok(res.procedureSql.includes('COMMIT;'));
    assert.ok(res.procedureSql.includes('v_total_updated := v_total_updated + v_rows_updated;'));
  });

  it('adds jittered sleep to throttle backfill batches', () => {
    const res = generateBackfillProcedure({
      table: 'events',
      fromColumn: 'data_old',
      toColumn: 'data_new',
    });

    assert.ok(res.procedureSql.includes('PERFORM pg_sleep(0.05 + random() * 0.05);'));
  });

  it('enforces SET LOCAL lock_timeout = 2s with exponential backoff on lock_not_available', () => {
    const res = generateBackfillProcedure({
      table: 'accounts',
      fromColumn: 'type_old',
      toColumn: 'type_new',
    });

    assert.ok(res.procedureSql.includes("EXECUTE 'SET LOCAL lock_timeout = ''2s'''"));
    assert.ok(res.procedureSql.includes('EXCEPTION WHEN lock_not_available THEN'));
    assert.ok(res.procedureSql.includes('v_backoff := v_backoff * 2;'));
    assert.ok(res.procedureSql.includes('PERFORM pg_sleep(v_backoff + random() * 0.05);'));
  });

  it('generates invocation CALL statement and custom primary key types', () => {
    const res = generateBackfillProcedure({
      table: 'logs',
      fromColumn: 'msg',
      toColumn: 'message',
      primaryKey: 'log_uuid',
      primaryKeyType: 'UUID',
      procedureName: 'sp_backfill_custom_logs',
    });

    assert.strictEqual(res.procedureName, 'sp_backfill_custom_logs');
    assert.ok(res.procedureSql.includes('v_last_id UUID := NULL;'));
    assert.ok(res.procedureSql.includes('WHERE "log_uuid" > v_last_id'));
    assert.ok(res.callSql.includes('CALL "public"."sp_backfill_custom_logs"();'));
  });
});

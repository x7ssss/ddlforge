/**
 * ddlforge - Dual-Write Trigger Generator Tests
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { generateDualWriteTrigger } from '../../src/orchestrator/dualWrite.js';

describe('DualWrite: generateDualWriteTrigger', () => {
  it('generates BEFORE INSERT OR UPDATE trigger with WHEN (pg_trigger_depth() < 2)', () => {
    const res = generateDualWriteTrigger({
      table: 'users',
      sourceColumn: 'name',
      targetColumn: 'full_name',
    });

    // Verify BEFORE INSERT OR UPDATE trigger
    assert.ok(res.triggerSql.includes('BEFORE INSERT OR UPDATE ON "public"."users"'));
    assert.ok(res.triggerSql.includes('FOR EACH ROW'));

    // Verify depth guard termination
    assert.ok(res.triggerSql.includes('WHEN (pg_trigger_depth() < 2)'));

    // Verify function definition
    assert.ok(res.functionSql.includes('CREATE OR REPLACE FUNCTION "public"."tf_sync_users_name_full_name"()'));
    assert.ok(res.functionSql.includes('RETURNS TRIGGER AS $$'));
    assert.ok(res.functionSql.includes('RETURN NEW;'));

    // Verify in-memory mutation without secondary UPDATE queries
    assert.ok(!res.functionSql.includes('UPDATE "public"."users"'));
    assert.ok(!res.functionSql.includes('UPDATE users'));
  });

  it('uses IS DISTINCT FROM for null-safe mutation detection', () => {
    const res = generateDualWriteTrigger({
      table: 'accounts',
      sourceColumn: 'old_status',
      targetColumn: 'new_status',
      bidirectional: true,
    });

    assert.ok(res.functionSql.includes('IS DISTINCT FROM'));
    assert.ok(res.functionSql.includes('NEW."old_status" IS DISTINCT FROM OLD."old_status"'));
    assert.ok(res.functionSql.includes('NEW."new_status" IS DISTINCT FROM OLD."new_status"'));
    assert.ok(res.functionSql.includes('NEW."old_status" IS DISTINCT FROM NEW."new_status"'));
  });

  it('supports custom forward and reverse transform expressions', () => {
    const res = generateDualWriteTrigger({
      table: 'metrics',
      sourceColumn: 'temp_c',
      targetColumn: 'temp_f',
      forwardTransform: '(NEW."temp_c" * 9 / 5) + 32',
      reverseTransform: '(NEW."temp_f" - 32) * 5 / 9',
    });

    assert.ok(res.functionSql.includes('NEW."temp_f" := (NEW."temp_c" * 9 / 5) + 32;'));
    assert.ok(res.functionSql.includes('NEW."temp_c" := (NEW."temp_f" - 32) * 5 / 9;'));
  });

  it('supports unidirectional synchronization mode', () => {
    const res = generateDualWriteTrigger({
      table: 'audit_logs',
      sourceColumn: 'payload',
      targetColumn: 'payload_v2',
      bidirectional: false,
    });

    assert.ok(res.functionSql.includes('Unidirectional forward synchronization'));
    assert.ok(res.functionSql.includes('NEW."payload_v2" := NEW."payload";'));
  });

  it('generates clean teardown script', () => {
    const res = generateDualWriteTrigger({
      table: 'users',
      sourceColumn: 'col_a',
      targetColumn: 'col_b',
    });

    assert.ok(res.teardownSql.includes('DROP TRIGGER IF EXISTS "trg_sync_users_col_a_col_b" ON "public"."users";'));
    assert.ok(res.teardownSql.includes('DROP FUNCTION IF EXISTS "public"."tf_sync_users_col_a_col_b"();'));
  });
});

/**
 * ddlforge - Contract Phase Teardown Generator Tests
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { generateContractScript } from '../../src/orchestrator/contract.js';

describe('Contract: generateContractScript', () => {
  it('emits GitLab 3-release teardown script with all 4 zero-downtime phases', () => {
    const res = generateContractScript({
      table: 'users',
      column: 'legacy_status',
      schema: 'public_v1',
    });

    assert.strictEqual(res.phases.length, 4);

    // Phase 1: Relax constraint
    assert.strictEqual(res.phases[0].phase, 1);
    assert.ok(res.phases[0].sql.includes('ALTER TABLE "public"."users" ALTER COLUMN "legacy_status" DROP NOT NULL;'));
    assert.ok(res.phases[0].sql.includes("SET LOCAL lock_timeout = '2s';"));

    // Phase 2: Drop triggers & functions
    assert.strictEqual(res.phases[1].phase, 2);
    assert.ok(res.phases[1].sql.includes('DROP TRIGGER IF EXISTS "trg_sync_users_legacy_status" ON "public"."users";'));
    assert.ok(res.phases[1].sql.includes('DROP FUNCTION IF EXISTS "public"."tf_sync_users_legacy_status"();'));

    // Phase 3: Drop legacy view and schema
    assert.strictEqual(res.phases[2].phase, 3);
    assert.ok(res.phases[2].sql.includes('DROP VIEW IF EXISTS "public_v1"."users";'));
    assert.ok(res.phases[2].sql.includes('DROP SCHEMA IF EXISTS "public_v1" CASCADE;'));

    // Phase 4: Drop physical column under advisory lock with retry
    assert.strictEqual(res.phases[3].phase, 4);
    assert.ok(res.phases[3].sql.includes("PERFORM pg_advisory_xact_lock(hashtext('public.users')::bigint);"));
    assert.ok(res.phases[3].sql.includes('EXECUTE \'ALTER TABLE "public"."users" DROP COLUMN IF EXISTS "legacy_status"\''));
  });

  it('includes PgBouncer cached prepared statements warning in scriptSql', () => {
    const res = generateContractScript({
      table: 'orders',
      column: 'old_amount',
    });

    assert.ok(res.warnings.some(w => w.includes('PgBouncer')));
    assert.ok(res.warnings.some(w => w.includes('cached plan must not change result type')));
    assert.ok(res.scriptSql.includes('cached plan must not change result type'));
  });

  it('supports custom physical schema and custom trigger/function names', () => {
    const res = generateContractScript({
      table: 'payments',
      column: 'cc_num',
      physicalSchema: 'finance',
      schema: 'finance_v1',
      triggerName: 'custom_trg_sync_cc',
      functionName: 'custom_fn_sync_cc',
    });

    assert.ok(res.scriptSql.includes('DROP TRIGGER IF EXISTS "custom_trg_sync_cc" ON "finance"."payments";'));
    assert.ok(res.scriptSql.includes('DROP FUNCTION IF EXISTS "finance"."custom_fn_sync_cc"();'));
    assert.ok(res.scriptSql.includes('DROP SCHEMA IF EXISTS "finance_v1" CASCADE;'));
    assert.ok(res.scriptSql.includes("hashtext('finance.payments')::bigint"));
  });
});

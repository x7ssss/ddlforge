import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { generateTableRepack } from '../../src/compaction/repack.js';

describe('Online Table Repack SQL Generator (src/compaction/repack.ts)', () => {
  it('throws error when table name is missing', () => {
    assert.throws(
      () => generateTableRepack({ table: '' }),
      /generateTableRepack: table name is required/
    );
  });

  it('generates standard 5-phase table repack script with default parameters', () => {
    const res = generateTableRepack({
      table: 'orders',
      primaryKey: 'id',
      primaryKeyType: 'BIGINT',
      schema: 'public',
    });

    // Phase 1: Shadow Table Setup
    assert.ok(res.phase1Sql.includes('CREATE TABLE "public"."orders_repack_shadow"'));
    assert.ok(res.phase1Sql.includes('LIKE "public"."orders" INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES'));

    // Phase 2: Audit Change-Log Trigger & Log Table
    assert.ok(res.phase2Sql.includes('CREATE TABLE IF NOT EXISTS "public"."orders_repack_log"'));
    assert.ok(res.phase2Sql.includes('id BIGSERIAL PRIMARY KEY'));
    assert.ok(res.phase2Sql.includes('op VARCHAR(1) NOT NULL'));
    assert.ok(res.phase2Sql.includes('pk_val BIGINT NOT NULL'));
    assert.ok(res.phase2Sql.includes('payload JSONB'));
    assert.ok(res.phase2Sql.includes('IF pg_trigger_depth() > 1 THEN'));
    assert.ok(res.phase2Sql.includes('RETURN NULL;'));
    assert.ok(res.phase2Sql.includes('CREATE OR REPLACE TRIGGER "trg_repack_log_orders"'));
    assert.ok(res.phase2Sql.includes('AFTER INSERT OR UPDATE OR DELETE ON "public"."orders"'));

    // Phase 3: Keyset Bulk Copy Procedure
    assert.ok(res.phase3Sql.includes('CREATE OR REPLACE PROCEDURE "public"."sp_repack_bulk_copy_orders"'));
    assert.ok(res.phase3Sql.includes('WHERE "id" > v_last_id'));
    assert.ok(res.phase3Sql.includes('ORDER BY "id" ASC'));
    assert.ok(res.phase3Sql.includes('LIMIT p_batch_size'));
    assert.ok(res.phase3Sql.includes('FOR UPDATE SKIP LOCKED'));
    assert.ok(res.phase3Sql.includes('ON CONFLICT ("id") DO NOTHING'));
    assert.ok(res.phase3Sql.includes('COMMIT;'));
    assert.ok(res.phase3Sql.includes('pg_sleep'));

    // Phase 4: Catch-up Replay Loop Procedure
    assert.ok(res.phase4Sql.includes('CREATE OR REPLACE PROCEDURE "public"."sp_repack_replay_log_orders"'));
    assert.ok(res.phase4Sql.includes('FROM "public"."orders_repack_log"'));
    assert.ok(res.phase4Sql.includes('jsonb_populate_record(NULL::"public"."orders_repack_shadow", v_rec.payload)'));
    assert.ok(res.phase4Sql.includes('DELETE FROM "public"."orders_repack_shadow" WHERE "id" = v_rec.pk_val'));

    // Phase 5: Bounded Cutover Atomic Swap
    assert.ok(res.phase5Sql.includes('BEGIN;'));
    assert.ok(res.phase5Sql.includes("SET LOCAL lock_timeout = '250ms';"));
    assert.ok(res.phase5Sql.includes("SET LOCAL statement_timeout = '5s';"));
    assert.ok(res.phase5Sql.includes('LOCK TABLE "public"."orders" IN ACCESS EXCLUSIVE MODE;'));
    assert.ok(res.phase5Sql.includes('SELECT COUNT(*) INTO v_src_count FROM "public"."orders";'));
    assert.ok(res.phase5Sql.includes('SELECT COUNT(*) INTO v_shadow_count FROM "public"."orders_repack_shadow";'));
    assert.ok(res.phase5Sql.includes('Parity check failed'));
    assert.ok(res.phase5Sql.includes('DROP TRIGGER IF EXISTS "trg_repack_log_orders"'));
    assert.ok(res.phase5Sql.includes('ALTER TABLE "public"."orders" RENAME TO "orders_legacy";'));
    assert.ok(res.phase5Sql.includes('ALTER TABLE "public"."orders_repack_shadow" RENAME TO "orders";'));
    assert.ok(res.phase5Sql.includes('COMMIT;'));

    // Full script contains all phases joined
    assert.ok(res.fullSql.includes('PHASE 1: SHADOW TABLE SETUP'));
    assert.ok(res.fullSql.includes('PHASE 2: AUDIT CHANGE-LOG TRIGGER'));
    assert.ok(res.fullSql.includes('PHASE 3: KEYSET SNAPSHOT BULK COPY'));
    assert.ok(res.fullSql.includes('PHASE 4: CATCH-UP REPLAY LOOP'));
    assert.ok(res.fullSql.includes('PHASE 5: BOUNDED ATOMIC CUTOVER'));
  });

  it('customizes tablespace, fillfactor, custom tables, and batching parameters', () => {
    const res = generateTableRepack({
      table: 'audit_events',
      primaryKey: 'uuid',
      primaryKeyType: 'UUID',
      schema: 'analytics',
      batchSize: 10000,
      throttleMs: 50,
      fillfactor: 85,
      tablespace: 'nvme_fast',
      shadowTable: 'audit_events_rebuilt',
      logTable: 'audit_events_delta',
      archiveTable: 'audit_events_old',
      lockTimeout: '500ms',
      statementTimeout: '10s',
    });

    assert.ok(res.phase1Sql.includes('CREATE TABLE "analytics"."audit_events_rebuilt"'));
    assert.ok(res.phase1Sql.includes('WITH (fillfactor = 85)'));
    assert.ok(res.phase1Sql.includes('TABLESPACE "nvme_fast"'));

    assert.ok(res.phase2Sql.includes('CREATE TABLE IF NOT EXISTS "analytics"."audit_events_delta"'));
    assert.ok(res.phase2Sql.includes('pk_val UUID NOT NULL'));

    assert.ok(res.phase3Sql.includes('p_batch_size INT DEFAULT 10000'));
    assert.ok(res.phase3Sql.includes('p_throttle_ms INT DEFAULT 50'));
    assert.ok(res.phase3Sql.includes('WHERE "uuid" > v_last_id'));

    assert.ok(res.phase4Sql.includes('jsonb_populate_record(NULL::"analytics"."audit_events_rebuilt", v_rec.payload)'));

    assert.ok(res.phase5Sql.includes("SET LOCAL lock_timeout = '500ms';"));
    assert.ok(res.phase5Sql.includes("SET LOCAL statement_timeout = '10s';"));
    assert.ok(res.phase5Sql.includes('LOCK TABLE "analytics"."audit_events" IN ACCESS EXCLUSIVE MODE;'));
    assert.ok(res.phase5Sql.includes('ALTER TABLE "analytics"."audit_events" RENAME TO "audit_events_old";'));
    assert.ok(res.phase5Sql.includes('ALTER TABLE "analytics"."audit_events_rebuilt" RENAME TO "audit_events";'));
  });
});

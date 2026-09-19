import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { generatePartitionConversion } from '../../src/partition/convert.js';

describe('Online Monolithic Table Conversion Generator', () => {
  it('generates a complete 4-phase conversion script with default parameters', () => {
    const result = generatePartitionConversion({
      table: 'events',
      key: 'created_at',
    });

    // Phase 1 assertions: Shadow partitioned table
    assert.ok(result.phase1Sql.includes('CREATE TABLE "public"."events_parted"'));
    assert.ok(result.phase1Sql.includes('LIKE "public"."events" INCLUDING DEFAULTS INCLUDING CONSTRAINTS'));
    assert.ok(result.phase1Sql.includes('PARTITION BY RANGE ("created_at")'));
    assert.ok(result.phase1Sql.includes('CREATE TABLE IF NOT EXISTS "public"."events_parted_default"'));
    assert.ok(result.phase1Sql.includes('PARTITION OF "public"."events_parted" DEFAULT'));

    // Phase 2 assertions: Scaffolding and triggers
    assert.ok(result.phase2Sql.includes('CREATE OR REPLACE FUNCTION "public"."_ddlforge_sync_events_to_parted"()'));
    assert.ok(result.phase2Sql.includes('pg_trigger_depth() > 1'));
    assert.ok(result.phase2Sql.includes('INSERT INTO "public"."events_parted" VALUES (NEW.*)'));
    assert.ok(result.phase2Sql.includes('CREATE OR REPLACE TRIGGER "trg_route_to_parted"'));
    assert.ok(result.phase2Sql.includes('CREATE OR REPLACE VIEW "public"."events_view"'));
    assert.ok(result.phase2Sql.includes('CREATE OR REPLACE TRIGGER "trg_route_to_legacy"'));

    // Phase 3 assertions: Keyset backfill procedure
    assert.ok(result.phase3Sql.includes('CREATE OR REPLACE PROCEDURE "public"."sp_convert_backfill_events"'));
    assert.ok(result.phase3Sql.includes('WHERE "id" > v_last_id'));
    assert.ok(result.phase3Sql.includes('ORDER BY "id" ASC'));
    assert.ok(result.phase3Sql.includes('LIMIT p_batch_size'));
    assert.ok(result.phase3Sql.includes('FOR UPDATE SKIP LOCKED'));
    assert.ok(result.phase3Sql.includes('ON CONFLICT DO NOTHING'));
    assert.ok(result.phase3Sql.includes('COMMIT;'));
    assert.ok(result.phase3Sql.includes('pg_sleep'));

    // Phase 4 assertions: Atomic contract & cutover swap
    assert.ok(result.phase4Sql.includes('LOCK TABLE "public"."events" IN ACCESS EXCLUSIVE MODE;'));
    assert.ok(result.phase4Sql.includes('DROP TRIGGER IF EXISTS "trg_route_to_parted" ON "public"."events";'));
    assert.ok(result.phase4Sql.includes('ALTER TABLE "public"."events" RENAME TO "events_legacy";'));
    assert.ok(result.phase4Sql.includes('ALTER TABLE "public"."events_parted" RENAME TO "events";'));
    assert.ok(result.phase4Sql.includes('COMMIT;'));

    // Full SQL should contain all 4 phases
    assert.ok(result.fullSql.includes('PHASE 1'));
    assert.ok(result.fullSql.includes('PHASE 2'));
    assert.ok(result.fullSql.includes('PHASE 3'));
    assert.ok(result.fullSql.includes('PHASE 4'));
  });

  it('supports list partitioning strategy and custom naming', () => {
    const result = generatePartitionConversion({
      table: 'orders',
      key: 'region',
      type: 'list',
      primaryKey: 'order_uuid',
      primaryKeyType: 'UUID',
      batchSize: 10000,
      throttleMs: 100,
      schema: 'sales',
      shadowTable: 'orders_partitioned',
      archiveTable: 'orders_backup',
      viewName: 'v_orders',
    });

    assert.ok(result.phase1Sql.includes('PARTITION BY LIST ("region")'));
    assert.ok(result.phase1Sql.includes('"sales"."orders_partitioned"'));
    assert.ok(result.phase2Sql.includes('"sales"."v_orders"'));
    assert.ok(result.phase3Sql.includes('WHERE "order_uuid" > v_last_id'));
    assert.ok(result.phase3Sql.includes('v_last_id UUID := 0;'));
    assert.ok(result.phase3Sql.includes('p_batch_size INT DEFAULT 10000'));
    assert.ok(result.phase3Sql.includes('p_throttle_ms INT DEFAULT 100'));
    assert.ok(result.phase4Sql.includes('RENAME TO "orders_backup"'));
    assert.ok(result.phase4Sql.includes('RENAME TO "orders"'));
  });

  it('validates required parameters', () => {
    assert.throws(
      () => generatePartitionConversion({ table: '', key: 'created_at' }),
      /table name is required/
    );

    assert.throws(
      () => generatePartitionConversion({ table: 'events', key: '' }),
      /partition key is required/
    );
  });
});

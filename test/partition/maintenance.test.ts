import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { generatePartitionMaintenance } from '../../src/partition/maintenance.js';

describe('Automated Partition Maintenance & Retention', () => {
  it('generates monthly rolling maintenance procedure with defaults', () => {
    const result = generatePartitionMaintenance({
      parent: 'events',
    });

    assert.strictEqual(result.procedureName, 'sp_maintain_events_partitions');
    assert.ok(result.procedureSql.includes('CREATE OR REPLACE PROCEDURE "public"."sp_maintain_events_partitions"'));
    assert.ok(result.procedureSql.includes("SET LOCAL lock_timeout = '2s';"));
    assert.ok(result.procedureSql.includes('date_trunc(\'month\', CURRENT_TIMESTAMP'));
    assert.ok(result.procedureSql.includes('FOR v_i IN 0..p_premake LOOP'));
    assert.ok(result.procedureSql.includes('PARTITION OF %I.%I FOR VALUES FROM (%L) TO (%L);'));
    assert.ok(result.procedureSql.includes('DETACH PARTITION'));
    assert.ok(result.procedureSql.includes('EXCEPTION'));
    assert.ok(result.procedureSql.includes('WHEN lock_not_available THEN'));
    assert.ok(result.procedureSql.includes('pg_sleep'));
    assert.ok(result.procedureSql.includes('to_timestamp'));
    assert.ok(result.procedureSql.includes('< v_cutoff'));
    assert.ok(result.callSql.includes('CALL "public"."sp_maintain_events_partitions"();'));
  });

  it('supports custom ddlforge_rolling_maintenance procedure name', () => {
    const result = generatePartitionMaintenance({
      parent: 'metrics',
      procedureName: 'ddlforge_rolling_maintenance',
    });

    assert.strictEqual(result.procedureName, 'ddlforge_rolling_maintenance');
    assert.ok(result.procedureSql.includes('CREATE OR REPLACE PROCEDURE "public"."ddlforge_rolling_maintenance"'));
    assert.ok(result.callSql.includes('CALL "public"."ddlforge_rolling_maintenance"();'));
  });

  it('generates daily rolling maintenance procedure with custom options', () => {
    const result = generatePartitionMaintenance({
      parent: 'telemetry',
      interval: 'daily',
      premake: 7,
      retention: 30,
      schema: 'iot',
      procedureName: 'sp_rolling_iot_telemetry',
      lockTimeout: '5s',
    });

    assert.strictEqual(result.procedureName, 'sp_rolling_iot_telemetry');
    assert.ok(result.procedureSql.includes('CREATE OR REPLACE PROCEDURE "iot"."sp_rolling_iot_telemetry"'));
    assert.ok(result.procedureSql.includes("SET LOCAL lock_timeout = '5s';"));
    assert.ok(result.procedureSql.includes('p_premake int DEFAULT 7'));
    assert.ok(result.procedureSql.includes('p_retention int DEFAULT 30'));
    assert.ok(result.procedureSql.includes('date_trunc(\'day\', CURRENT_TIMESTAMP'));
    assert.ok(result.procedureSql.includes('YYYY_MM_DD'));
    assert.ok(result.procedureSql.includes('pg_sleep'));
    assert.ok(result.callSql.includes('CALL "iot"."sp_rolling_iot_telemetry"();'));
  });

  it('validates required parameters', () => {
    assert.throws(
      () => generatePartitionMaintenance({ parent: '' }),
      /parent table name is required/
    );
  });
});

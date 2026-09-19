import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { generatePartitionAttachment, formatBoundValue } from '../../src/partition/attach.js';

describe('Scan-Skipping Partition Attacher', () => {
  describe('formatBoundValue', () => {
    it('formats numbers bare', () => {
      assert.strictEqual(formatBoundValue(100), '100');
      assert.strictEqual(formatBoundValue('42'), '42');
      assert.strictEqual(formatBoundValue('-10.5'), '-10.5');
    });

    it('formats strings with single quotes', () => {
      assert.strictEqual(formatBoundValue('2026-10-01'), "'2026-10-01'");
      assert.strictEqual(formatBoundValue("'2026-10-01'"), "'2026-10-01'");
    });

    it('escapes internal quotes in strings', () => {
      assert.strictEqual(formatBoundValue("O'Reilly"), "'O''Reilly'");
    });
  });

  describe('generatePartitionAttachment', () => {
    it('generates the safe 3-phase scan-skipping attachment script', () => {
      const result = generatePartitionAttachment({
        parent: 'events',
        partition: 'events_2026_10',
        from: '2026-10-01',
        to: '2026-11-01',
        key: 'created_at',
      });

      // Phase 1: ADD CONSTRAINT ... NOT VALID
      assert.ok(result.phase1Sql.includes('ALTER TABLE "public"."events_2026_10"'));
      assert.ok(result.phase1Sql.includes('ADD CONSTRAINT "events_2026_10_bnd_chk"'));
      assert.ok(result.phase1Sql.includes(`CHECK ("created_at" >= '2026-10-01' AND "created_at" < '2026-11-01') NOT VALID;`));

      // Phase 2: VALIDATE CONSTRAINT (isolated)
      assert.ok(result.phase2Sql.includes('ALTER TABLE "public"."events_2026_10"'));
      assert.ok(result.phase2Sql.includes('VALIDATE CONSTRAINT "events_2026_10_bnd_chk";'));

      // Phase 3: ATTACH PARTITION & DROP redundant check
      assert.ok(result.phase3Sql.includes('ALTER TABLE "public"."events"'));
      assert.ok(result.phase3Sql.includes('ATTACH PARTITION "public"."events_2026_10"'));
      assert.ok(result.phase3Sql.includes(`FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');`));
      assert.ok(result.phase3Sql.includes('DROP CONSTRAINT "events_2026_10_bnd_chk";'));

      // Full SQL contains all 3 phases
      assert.ok(result.fullSql.includes('PHASE 1'));
      assert.ok(result.fullSql.includes('PHASE 2'));
      assert.ok(result.fullSql.includes('PHASE 3'));
    });

    it('supports custom schema, key, and constraint name', () => {
      const result = generatePartitionAttachment({
        parent: 'measurements',
        partition: 'measurements_p100',
        from: 0,
        to: 100,
        key: 'device_id',
        schema: 'iot',
        constraintName: 'chk_p100_bounds',
      });

      assert.strictEqual(result.constraintName, 'chk_p100_bounds');
      assert.ok(result.phase1Sql.includes('"iot"."measurements_p100"'));
      assert.ok(result.phase1Sql.includes('CHECK ("device_id" >= 0 AND "device_id" < 100) NOT VALID;'));
      assert.ok(result.phase3Sql.includes('FOR VALUES FROM (0) TO (100)'));
    });

    it('validates required parameters', () => {
      assert.throws(
        () => generatePartitionAttachment({ parent: '', partition: 'p1', from: '0', to: '10' }),
        /parent table name is required/
      );

      assert.throws(
        () => generatePartitionAttachment({ parent: 'p', partition: '', from: '0', to: '10' }),
        /partition table name is required/
      );

      assert.throws(
        () => generatePartitionAttachment({ parent: 'p', partition: 'p1', from: '', to: '10' }),
        /lower bound/
      );

      assert.throws(
        () => generatePartitionAttachment({ parent: 'p', partition: 'p1', from: '0', to: '' }),
        /upper bound/
      );
    });
  });
});

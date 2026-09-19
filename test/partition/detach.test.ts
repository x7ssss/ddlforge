import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { generatePartitionDetachment } from '../../src/partition/detach.js';

describe('Concurrent Partition Detacher & Remediation', () => {
  it('generates autocommit-safe DETACH PARTITION CONCURRENTLY by default', () => {
    const result = generatePartitionDetachment({
      parent: 'events',
      partition: 'events_2026_01',
    });

    assert.strictEqual(result.isConcurrent, true);
    assert.ok(result.detachSql.includes('ALTER TABLE "public"."events"'));
    assert.ok(result.detachSql.includes('DETACH PARTITION "public"."events_2026_01" CONCURRENTLY;'));
    assert.ok(result.detachSql.includes('cannot run inside a transaction block'));

    // Post-detachment FK anomaly remediation
    assert.ok(result.fkRemediationSql.includes('pg_constraint'));
    assert.ok(result.fkRemediationSql.includes('VALIDATE CONSTRAINT'));
    assert.ok(result.fullSql.includes('POST-DETACHMENT FOREIGN KEY ANOMALY REMEDIATION'));
  });

  it('generates standard non-concurrent detachment inside transaction block when requested', () => {
    const result = generatePartitionDetachment({
      parent: 'logs',
      partition: 'logs_old',
      concurrent: false,
      schema: 'audit',
      cleanupFk: false,
    });

    assert.strictEqual(result.isConcurrent, false);
    assert.ok(result.detachSql.includes('BEGIN;'));
    assert.ok(result.detachSql.includes('ALTER TABLE "audit"."logs"'));
    assert.ok(result.detachSql.includes('DETACH PARTITION "audit"."logs_old";'));
    assert.ok(result.detachSql.includes('COMMIT;'));
    assert.strictEqual(result.fkRemediationSql, '');
  });

  it('validates required parameters', () => {
    assert.throws(
      () => generatePartitionDetachment({ parent: '', partition: 'part' }),
      /parent table name is required/
    );

    assert.throws(
      () => generatePartitionDetachment({ parent: 'events', partition: '' }),
      /partition table name is required/
    );
  });
});

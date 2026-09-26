/**
 * ddlforge — test/adversarial.test.ts
 *
 * Adversarial real-world migration test suite based on production postmortem data (PG 13-17).
 * Tests all 10 production lock-hazard and table-rewrite failure patterns.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { analyzeSql } from '../src/engine/analyzer.js';
import { PostgresLockLevel } from '../src/engine/locks.js';

describe('Production Postmortem Adversarial Migration Test Suite (PG 13-17)', () => {
  // Pattern 1: Inline unvalidated foreign key on populated tables
  it('Pattern 1: detects inline unvalidated foreign key as unvalidated-foreign-key BLOCKER', () => {
    const sql = 'ALTER TABLE payments ADD CONSTRAINT fk_payments_customer FOREIGN KEY (customer_id) REFERENCES customers (id);';
    const res = analyzeSql(sql, { filePath: 'migrations/01_payments_fk.sql' });

    assert.strictEqual(res.hasBlockers, true);
    const f = res.findings.find(item => item.ruleId === 'unvalidated-foreign-key' || item.ruleId === 'foreign-key-missing-not-valid');
    assert.ok(f, 'Must flag under unvalidated-foreign-key rule');
    assert.strictEqual(f.severity, 'BLOCKER');
    assert.strictEqual(f.lockLevel, PostgresLockLevel.SHARE_ROW_EXCLUSIVE);
    assert.ok(f.message.includes('payments'));
    assert.ok(f.suggestion.includes('NOT VALID'));
  });

  // Pattern 2: Adding column with volatile DEFAULT
  it('Pattern 2: detects adding column with volatile DEFAULT as volatile-default BLOCKER', () => {
    const sql = 'ALTER TABLE users ADD COLUMN created_at TIMESTAMPTZ DEFAULT clock_timestamp();';
    const res = analyzeSql(sql, { filePath: 'migrations/02_volatile_default.sql' });

    assert.strictEqual(res.hasBlockers, true);
    const f = res.findings.find(item => item.ruleId === 'volatile-default');
    assert.ok(f, 'Must flag under volatile-default rule');
    assert.strictEqual(f.severity, 'BLOCKER');
    assert.strictEqual(f.lockLevel, PostgresLockLevel.ACCESS_EXCLUSIVE);
    assert.ok(f.message.includes('created_at'));
    assert.ok(f.message.includes('clock_timestamp()'));

    // Also test random() and uuid_generate_v4()
    const sql2 = 'ALTER TABLE tokens ADD COLUMN secret TEXT DEFAULT random()::text;';
    const res2 = analyzeSql(sql2);
    assert.ok(res2.findings.some(item => item.ruleId === 'volatile-default'));

    const sql3 = 'ALTER TABLE orders ADD COLUMN order_id UUID DEFAULT uuid_generate_v4();';
    const res3 = analyzeSql(sql3);
    assert.ok(res3.findings.some(item => item.ruleId === 'volatile-default'));
  });

  // Pattern 3: ALTER COLUMN SET NOT NULL on existing populated column
  it('Pattern 3: detects direct ALTER COLUMN SET NOT NULL as set-not-null-full-scan hazard', () => {
    const sql = 'ALTER TABLE users ALTER COLUMN email SET NOT NULL;';
    const res = analyzeSql(sql, { filePath: 'migrations/03_not_null.sql' });

    const f = res.findings.find(item => item.ruleId === 'set-not-null-full-scan');
    assert.ok(f, 'Must flag under set-not-null-full-scan rule');
    assert.strictEqual(f.lockLevel, PostgresLockLevel.ACCESS_EXCLUSIVE);
    assert.ok(f.suggestion.includes('NOT VALID'));
    assert.ok(f.suggestion.includes('VALIDATE CONSTRAINT'));
  });

  // Pattern 4: ALTER COLUMN TYPE rewrite (e.g. integer to bigint)
  it('Pattern 4: detects ALTER COLUMN TYPE rewrite hazard', () => {
    const sql = 'ALTER TABLE events ALTER COLUMN id TYPE bigint;';
    const res = analyzeSql(sql, { filePath: 'migrations/04_type_rewrite.sql' });

    assert.strictEqual(res.hasBlockers, true);
    const f = res.findings.find(item => item.ruleId === 'alter-column-type-rewrite');
    assert.ok(f, 'Must flag under alter-column-type-rewrite rule');
    assert.strictEqual(f.severity, 'BLOCKER');
    assert.strictEqual(f.lockLevel, PostgresLockLevel.ACCESS_EXCLUSIVE);
    assert.ok(f.message.includes('events'));
    assert.ok(f.message.includes('id'));
  });

  // Pattern 5: Concurrent index or partition detach inside explicit transaction
  it('Pattern 5: detects CREATE INDEX CONCURRENTLY inside explicit transaction block', () => {
    const sql = `
      BEGIN;
      CREATE INDEX CONCURRENTLY idx_users_email ON users (email);
      COMMIT;
    `;
    const res = analyzeSql(sql, { filePath: 'migrations/05_tx_trap.sql' });

    assert.strictEqual(res.hasBlockers, true);
    const f = res.findings.find(
      item => item.ruleId === 'concurrent-in-transaction' || item.ruleId === 'concurrent-index-in-transaction'
    );
    assert.ok(f, 'Must flag under concurrent-in-transaction rule');
    assert.strictEqual(f.severity, 'BLOCKER');

    // Also test DETACH PARTITION CONCURRENTLY inside transaction
    const sqlDetach = `
      BEGIN;
      ALTER TABLE measurements DETACH PARTITION measurements_2025 CONCURRENTLY;
      COMMIT;
    `;
    const resDetach = analyzeSql(sqlDetach);
    assert.ok(
      resDetach.findings.some(
        item => item.ruleId === 'concurrent-in-transaction' || item.ruleId === 'concurrent-index-in-transaction'
      )
    );
  });

  // Pattern 6: Primary Key attachment using existing unique index on nullable column
  it('Pattern 6: detects PRIMARY KEY USING INDEX on nullable column without prior validated NOT NULL', () => {
    const sql = 'ALTER TABLE orders ADD CONSTRAINT pk_orders PRIMARY KEY USING INDEX idx_orders_id;';
    const res = analyzeSql(sql, { filePath: 'migrations/06_pk_nullable.sql' });

    const f = res.findings.find(
      item =>
        item.ruleId === 'primary-key-using-index-nullable-column' ||
        item.ruleId === 'add-primary-key-missing-using-index'
    );
    assert.ok(f, 'Must detect primary key using index on nullable column hazard');
    assert.strictEqual(f.lockLevel, PostgresLockLevel.ACCESS_EXCLUSIVE);
  });

  // Pattern 7: DROP COLUMN without prior application decoupling / deprecation
  it('Pattern 7: detects DROP COLUMN ACCESS EXCLUSIVE lock hazard', () => {
    const sql = 'ALTER TABLE users DROP COLUMN legacy_data;';
    const res = analyzeSql(sql, { filePath: 'migrations/07_drop_col.sql' });

    const f = res.findings.find(item => item.ruleId === 'drop-column-lock');
    assert.ok(f, 'Must flag under drop-column-lock rule');
    assert.strictEqual(f.lockLevel, PostgresLockLevel.ACCESS_EXCLUSIVE);
    assert.ok(f.message.includes('legacy_data'));
  });

  // Pattern 8: Non-concurrent DROP INDEX
  it('Pattern 8: detects DROP INDEX without CONCURRENTLY as non-concurrent-drop-index BLOCKER', () => {
    const sql = 'DROP INDEX idx_logs_timestamp;';
    const res = analyzeSql(sql, { filePath: 'migrations/08_drop_idx.sql' });

    assert.strictEqual(res.hasBlockers, true);
    const f = res.findings.find(item => item.ruleId === 'non-concurrent-drop-index');
    assert.ok(f, 'Must flag under non-concurrent-drop-index rule');
    assert.strictEqual(f.severity, 'BLOCKER');
    assert.strictEqual(f.lockLevel, PostgresLockLevel.ACCESS_EXCLUSIVE);
    assert.ok(f.message.includes('idx_logs_timestamp'));
    assert.ok(f.suggestion.includes('DROP INDEX CONCURRENTLY'));
  });

  // Pattern 9: ATTACH PARTITION without pre-validated bounds check
  it('Pattern 9: detects ATTACH PARTITION without pre-validated check constraint under partition-scan-lock', () => {
    const sql = `ALTER TABLE sensor_readings ATTACH PARTITION sensor_readings_2026 FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');`;
    const res = analyzeSql(sql, { filePath: 'migrations/09_attach_partition.sql' });

    assert.strictEqual(res.hasBlockers, true);
    const f = res.findings.find(
      item => item.ruleId === 'partition-scan-lock' || item.ruleId === 'attach-partition-missing-check'
    );
    assert.ok(f, 'Must flag under partition-scan-lock rule');
    assert.strictEqual(f.severity, 'BLOCKER');
    assert.strictEqual(f.lockLevel, PostgresLockLevel.ACCESS_EXCLUSIVE);
    assert.ok(f.suggestion.includes('NOT VALID'));
    assert.ok(f.suggestion.includes('VALIDATE CONSTRAINT'));
  });

  // Pattern 10: REINDEX without CONCURRENTLY
  it('Pattern 10: detects REINDEX TABLE without CONCURRENTLY as reindex-missing-concurrently BLOCKER', () => {
    const sql = 'REINDEX TABLE orders;';
    const res = analyzeSql(sql, { filePath: 'migrations/10_reindex.sql' });

    assert.strictEqual(res.hasBlockers, true);
    const f = res.findings.find(item => item.ruleId === 'reindex-missing-concurrently');
    assert.ok(f, 'Must flag under reindex-missing-concurrently rule');
    assert.strictEqual(f.severity, 'BLOCKER');
    assert.ok(
      f.lockLevel === PostgresLockLevel.ACCESS_EXCLUSIVE || f.lockLevel === PostgresLockLevel.SHARE,
      'Lock level must be ACCESS EXCLUSIVE or SHARE'
    );
    assert.ok(f.suggestion.includes('REINDEX TABLE CONCURRENTLY'));
  });

  // Multi-pattern composite test
  it('detects multiple production postmortem hazards in a single adversarial migration', () => {
    const compositeSql = `
      -- 1. Unvalidated FK
      ALTER TABLE payments ADD CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id);

      -- 2. Volatile default
      ALTER TABLE payments ADD COLUMN recorded_at TIMESTAMPTZ DEFAULT clock_timestamp();

      -- 3. Non-concurrent DROP INDEX
      DROP INDEX idx_old_payments;

      -- 4. REINDEX without CONCURRENTLY
      REINDEX TABLE payments;
    `;
    const res = analyzeSql(compositeSql, { filePath: 'migrations/adversarial_composite.sql' });

    assert.strictEqual(res.hasBlockers, true);
    assert.ok(res.blockersCount >= 4, `Expected at least 4 blockers, got ${res.blockersCount}`);

    const ruleIds = new Set(res.findings.map(f => f.ruleId));
    assert.ok(
      ruleIds.has('unvalidated-foreign-key') || ruleIds.has('foreign-key-missing-not-valid'),
      'Must contain unvalidated-foreign-key finding'
    );
    assert.ok(ruleIds.has('volatile-default'));
    assert.ok(ruleIds.has('non-concurrent-drop-index'));
    assert.ok(ruleIds.has('reindex-missing-concurrently'));
  });

  // Safe pattern verification
  it('passes completely with 0 blockers when safe zero-downtime equivalents are used', () => {
    const safeSql = `
      -- Safe 1: FK with NOT VALID + isolated validate
      ALTER TABLE payments ADD CONSTRAINT fk_payments_customer FOREIGN KEY (customer_id) REFERENCES customers (id) NOT VALID;
      ALTER TABLE payments VALIDATE CONSTRAINT fk_payments_customer;

      -- Safe 2: Constant DEFAULT or nullable add
      ALTER TABLE users ADD COLUMN created_at TIMESTAMPTZ DEFAULT '2026-01-01 00:00:00+00';

      -- Safe 3: Concurrent DROP INDEX standalone
      DROP INDEX CONCURRENTLY idx_logs_timestamp;

      -- Safe 4: Concurrent REINDEX
      REINDEX TABLE CONCURRENTLY orders;
    `;
    const res = analyzeSql(safeSql, { pgVersion: 16 });
    assert.strictEqual(res.blockersCount, 0, `Expected 0 blockers in safe migration, got: ${JSON.stringify(res.findings.filter(f => f.severity === 'BLOCKER'))}`);
  });
});

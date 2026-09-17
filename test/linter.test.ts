/**
 * ddlforge - Unit tests for rules 8–13 (check-constraint-not-valid,
 * unique-constraint-using-index, session-advisory-lock,
 * alter-column-type-rewrite, unindexed-foreign-key, drop-column-lock)
 * and fixture verification.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { analyzeSql } from '../src/index.js';
import {
  checkConstraintNotValidRule,
  uniqueConstraintUsingIndexRule,
  sessionAdvisoryLockRule,
  alterColumnTypeRewriteRule,
  unindexedForeignKeyRule,
  dropColumnLockRule,
} from '../src/rules/index.js';

// ---------------------------------------------------------------------------
// Rule 8: checkConstraintNotValid (check-constraint-not-valid)
// ---------------------------------------------------------------------------

describe('Rule 8: checkConstraintNotValid (check-constraint-not-valid)', () => {
  it('detects ADD CONSTRAINT CHECK without NOT VALID as BLOCKER', () => {
    const sql = 'ALTER TABLE orders ADD CONSTRAINT orders_amount_positive CHECK (amount > 0);';
    const res = analyzeSql(sql, { rules: [checkConstraintNotValidRule] });
    assert.strictEqual(res.blockersCount, 1);
    const f = res.findings[0];
    assert.strictEqual(f.ruleId, 'check-constraint-not-valid');
    assert.strictEqual(f.severity, 'BLOCKER');
    assert.ok(f.suggestion.includes('NOT VALID'));
    assert.ok(f.suggestion.includes('VALIDATE CONSTRAINT'));
  });

  it('passes ADD CONSTRAINT CHECK ... NOT VALID', () => {
    const sql = 'ALTER TABLE orders ADD CONSTRAINT orders_amount_positive CHECK (amount > 0) NOT VALID;';
    const res = analyzeSql(sql, { rules: [checkConstraintNotValidRule] });
    assert.strictEqual(res.blockersCount, 0);
    assert.strictEqual(res.findings.length, 0);
  });

  it('passes VALIDATE CONSTRAINT statement', () => {
    const sql = 'ALTER TABLE orders VALIDATE CONSTRAINT orders_amount_positive;';
    const res = analyzeSql(sql, { rules: [checkConstraintNotValidRule] });
    assert.strictEqual(res.blockersCount, 0);
  });

  it('detects multiple CHECK constraints in one ALTER TABLE', () => {
    const sql = `ALTER TABLE orders
      ADD CONSTRAINT chk_amount CHECK (amount > 0),
      ADD CONSTRAINT chk_status CHECK (status IN ('a','b')) NOT VALID;`;
    const res = analyzeSql(sql, { rules: [checkConstraintNotValidRule] });
    // Only the first lacks NOT VALID
    assert.strictEqual(res.blockersCount, 1);
  });

  it('passes when ignored with directive comment', () => {
    const sql = `-- ddlforge-ignore check-constraint-not-valid
ALTER TABLE orders ADD CONSTRAINT chk_amt CHECK (amount > 0);`;
    const res = analyzeSql(sql, { rules: [checkConstraintNotValidRule] });
    assert.strictEqual(res.findings.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Rule 9: uniqueConstraintUsingIndex (unique-constraint-using-index)
// ---------------------------------------------------------------------------

describe('Rule 9: uniqueConstraintUsingIndex (unique-constraint-using-index)', () => {
  it('detects ADD CONSTRAINT UNIQUE (...) as BLOCKER with SHARE lock', () => {
    const sql = 'ALTER TABLE users ADD CONSTRAINT users_email_unique UNIQUE (email);';
    const res = analyzeSql(sql, { rules: [uniqueConstraintUsingIndexRule] });
    assert.strictEqual(res.blockersCount, 1);
    const f = res.findings[0];
    assert.strictEqual(f.ruleId, 'unique-constraint-using-index');
    assert.strictEqual(f.severity, 'BLOCKER');
    assert.ok(f.suggestion.includes('CREATE UNIQUE INDEX CONCURRENTLY'));
    assert.ok(f.suggestion.includes('UNIQUE USING INDEX'));
  });

  it('passes ADD CONSTRAINT UNIQUE USING INDEX (two-phase safe form)', () => {
    const sql = 'ALTER TABLE users ADD CONSTRAINT users_email_unique UNIQUE USING INDEX idx_users_email;';
    const res = analyzeSql(sql, { rules: [uniqueConstraintUsingIndexRule] });
    assert.strictEqual(res.blockersCount, 0);
    assert.strictEqual(res.findings.length, 0);
  });

  it('passes when ignored with directive comment', () => {
    const sql = `-- ddlforge-ignore unique-constraint-using-index
ALTER TABLE users ADD CONSTRAINT users_email_unique UNIQUE (email);`;
    const res = analyzeSql(sql, { rules: [uniqueConstraintUsingIndexRule] });
    assert.strictEqual(res.findings.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Rule 10: sessionAdvisoryLock (session-advisory-lock)
// ---------------------------------------------------------------------------

describe('Rule 10: sessionAdvisoryLock (session-advisory-lock)', () => {
  it('detects pg_advisory_lock as WARNING', () => {
    const sql = 'SELECT pg_advisory_lock(12345);';
    const res = analyzeSql(sql, { rules: [sessionAdvisoryLockRule] });
    assert.strictEqual(res.warningsCount, 1);
    const f = res.findings[0];
    assert.strictEqual(f.ruleId, 'session-advisory-lock');
    assert.strictEqual(f.severity, 'WARNING');
    assert.ok(f.suggestion.includes('pg_advisory_xact_lock'));
  });

  it('detects pg_try_advisory_lock as WARNING', () => {
    const sql = 'SELECT pg_try_advisory_lock(12345);';
    const res = analyzeSql(sql, { rules: [sessionAdvisoryLockRule] });
    assert.strictEqual(res.warningsCount, 1);
  });

  it('passes pg_advisory_xact_lock (transaction-scoped)', () => {
    const sql = 'SELECT pg_advisory_xact_lock(12345);';
    const res = analyzeSql(sql, { rules: [sessionAdvisoryLockRule] });
    assert.strictEqual(res.findings.length, 0);
  });

  it('passes pg_try_advisory_xact_lock (transaction-scoped)', () => {
    const sql = 'SELECT pg_try_advisory_xact_lock(12345);';
    const res = analyzeSql(sql, { rules: [sessionAdvisoryLockRule] });
    assert.strictEqual(res.findings.length, 0);
  });

  it('passes when ignored with directive comment', () => {
    const sql = `-- ddlforge-ignore session-advisory-lock
SELECT pg_advisory_lock(42);`;
    const res = analyzeSql(sql, { rules: [sessionAdvisoryLockRule] });
    assert.strictEqual(res.findings.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Fixture Verification: New dangerous/safe fixtures
// ---------------------------------------------------------------------------

describe('Fixture Verification: v0.3.0 dangerous fixtures', () => {
  const dangerousDir = path.resolve('test/fixtures/dangerous');
  const newDangerousFixtures = [
    '04_unsafe_check_constraint.sql',
    '05_unsafe_unique_constraint.sql',
    '06_unsafe_advisory_lock.sql',
  ];

  for (const fixture of newDangerousFixtures) {
    it(`${fixture} produces at least 1 blocker or warning`, () => {
      const sql = fs.readFileSync(path.join(dangerousDir, fixture), 'utf-8');
      const res = analyzeSql(sql);
      assert.ok(
        res.blockersCount > 0 || res.warningsCount > 0,
        `Expected violations in ${fixture} but found none`,
      );
    });
  }
});

describe('Fixture Verification: v0.3.0 safe fixtures', () => {
  const safeDir = path.resolve('test/fixtures/safe');
  const newSafeFixtures = [
    '08_safe_check_constraint.sql',
    '09_safe_unique_constraint.sql',
    '10_safe_advisory_lock.sql',
  ];

  for (const fixture of newSafeFixtures) {
    it(`${fixture} produces 0 blockers`, () => {
      const sql = fs.readFileSync(path.join(safeDir, fixture), 'utf-8');
      const res = analyzeSql(sql);
      assert.strictEqual(res.blockersCount, 0, `Unexpected blockers in ${fixture}`);
    });
  }
});

// ---------------------------------------------------------------------------
// Rule 11: alterColumnTypeRewrite (alter-column-type-rewrite)
// ---------------------------------------------------------------------------

describe('Rule 11: alterColumnTypeRewrite (alter-column-type-rewrite)', () => {
  it('detects ALTER COLUMN TYPE text as BLOCKER with ACCESS EXCLUSIVE lock', () => {
    const sql = 'ALTER TABLE users ALTER COLUMN email TYPE text;';
    const res = analyzeSql(sql, { rules: [alterColumnTypeRewriteRule] });
    assert.strictEqual(res.blockersCount, 1);
    const f = res.findings[0];
    assert.strictEqual(f.ruleId, 'alter-column-type-rewrite');
    assert.strictEqual(f.severity, 'BLOCKER');
    assert.ok(f.message.includes('"email"'));
    assert.ok(f.message.includes('"users"'));
    assert.ok(f.suggestion.includes('ADD COLUMN'));
    assert.ok(f.suggestion.includes('RENAME COLUMN'));
  });

  it('detects ALTER COLUMN TYPE bigint as BLOCKER', () => {
    const sql = 'ALTER TABLE users ALTER COLUMN age TYPE bigint;';
    const res = analyzeSql(sql, { rules: [alterColumnTypeRewriteRule] });
    assert.strictEqual(res.blockersCount, 1);
    const f = res.findings[0];
    assert.ok(f.message.includes('"age"'));
    assert.ok(f.message.includes('"users"'));
  });

  it('detects ALTER COLUMN TYPE varchar(200) as BLOCKER', () => {
    const sql = 'ALTER TABLE users ALTER COLUMN name TYPE varchar(200);';
    const res = analyzeSql(sql, { rules: [alterColumnTypeRewriteRule] });
    assert.strictEqual(res.blockersCount, 1);
    assert.ok(res.findings[0].message.includes('"name"'));
  });

  it('passes ALTER TABLE ... ADD COLUMN (not ALTER COLUMN TYPE)', () => {
    const sql = 'ALTER TABLE users ADD COLUMN foo text;';
    const res = analyzeSql(sql, { rules: [alterColumnTypeRewriteRule] });
    assert.strictEqual(res.findings.length, 0);
  });

  it('passes when ignored with directive comment', () => {
    const sql = `-- ddlforge-ignore alter-column-type-rewrite\nALTER TABLE users ALTER COLUMN email TYPE text;`;
    const res = analyzeSql(sql, { rules: [alterColumnTypeRewriteRule] });
    assert.strictEqual(res.findings.length, 0);
  });

  it('detects SET DATA TYPE variant as BLOCKER', () => {
    const sql = 'ALTER TABLE t ALTER COLUMN c SET DATA TYPE jsonb;';
    const res = analyzeSql(sql, { rules: [alterColumnTypeRewriteRule] });
    assert.strictEqual(res.blockersCount, 1);
    const f = res.findings[0];
    assert.ok(f.message.includes('"c"'));
    assert.ok(f.message.includes('"t"'));
  });

  it('detects with IF EXISTS modifier on table', () => {
    const sql = 'ALTER TABLE IF EXISTS users ALTER COLUMN email TYPE text;';
    const res = analyzeSql(sql, { rules: [alterColumnTypeRewriteRule] });
    assert.strictEqual(res.blockersCount, 1);
    assert.ok(res.findings[0].message.includes('"email"'));
  });

  it('detects multiple ALTER COLUMN TYPE in one statement', () => {
    const sql = 'ALTER TABLE t ALTER COLUMN a TYPE bigint, ALTER COLUMN b TYPE text;';
    const res = analyzeSql(sql, { rules: [alterColumnTypeRewriteRule] });
    assert.strictEqual(res.blockersCount, 2);
  });

  it('passes varchar(X) -> varchar(Y) where Y >= X as WARNING (not BLOCKER) with prior schema', () => {
    const sql = `
      CREATE TABLE users (id serial primary key, name varchar(50));
      ALTER TABLE users ALTER COLUMN name TYPE varchar(100);
    `;
    const res = analyzeSql(sql, { rules: [alterColumnTypeRewriteRule] });
    assert.strictEqual(res.blockersCount, 0);
    assert.strictEqual(res.warningsCount, 1);
    assert.strictEqual(res.findings[0].severity, 'WARNING');
    assert.ok(res.findings[0].message.includes('metadata-only'));
  });

  it('flags varchar(X) -> varchar(Y) where Y < X (shrinking) as BLOCKER', () => {
    const sql = `
      CREATE TABLE users (id serial primary key, name varchar(100));
      ALTER TABLE users ALTER COLUMN name TYPE varchar(50);
    `;
    const res = analyzeSql(sql, { rules: [alterColumnTypeRewriteRule] });
    assert.strictEqual(res.blockersCount, 1);
    assert.strictEqual(res.findings[0].severity, 'BLOCKER');
  });

  it('passes varchar(X) -> text as WARNING (not BLOCKER) with prior schema', () => {
    const sql = `
      CREATE TABLE users (id serial primary key, bio varchar(255));
      ALTER TABLE users ALTER COLUMN bio TYPE text;
    `;
    const res = analyzeSql(sql, { rules: [alterColumnTypeRewriteRule] });
    assert.strictEqual(res.blockersCount, 0);
    assert.strictEqual(res.warningsCount, 1);
  });

  it('passes varchar(X) -> varchar(Y) with comment hint as WARNING (not BLOCKER)', () => {
    const sql = `
      -- was: varchar(50)
      ALTER TABLE users ALTER COLUMN name TYPE varchar(100);
    `;
    const res = analyzeSql(sql, { rules: [alterColumnTypeRewriteRule] });
    assert.strictEqual(res.blockersCount, 0);
    assert.strictEqual(res.warningsCount, 1);
    assert.strictEqual(res.findings[0].severity, 'WARNING');
  });

  it('flags varchar(X) to integer as BLOCKER even with prior schema', () => {
    const sql = `
      CREATE TABLE users (id serial primary key, code varchar(50));
      ALTER TABLE users ALTER COLUMN code TYPE integer;
    `;
    const res = analyzeSql(sql, { rules: [alterColumnTypeRewriteRule] });
    assert.strictEqual(res.blockersCount, 1);
    assert.strictEqual(res.findings[0].severity, 'BLOCKER');
  });
});

// ---------------------------------------------------------------------------
// Rule 12: unindexedForeignKey (unindexed-foreign-key)
// ---------------------------------------------------------------------------

describe('Rule 12: unindexedForeignKey (unindexed-foreign-key)', () => {
  it('detects ADD CONSTRAINT FOREIGN KEY as WARNING', () => {
    const sql = 'ALTER TABLE orders ADD CONSTRAINT fk_customer FOREIGN KEY (customer_id) REFERENCES customers(id);';
    const res = analyzeSql(sql, { rules: [unindexedForeignKeyRule] });
    assert.strictEqual(res.warningsCount, 1);
    const f = res.findings[0];
    assert.strictEqual(f.ruleId, 'unindexed-foreign-key');
    assert.strictEqual(f.severity, 'WARNING');
    assert.ok(f.message.includes('"orders"'));
    assert.ok(f.suggestion.includes('CREATE INDEX CONCURRENTLY'));
    assert.ok(f.suggestion.includes('NOT VALID'));
  });

  it('still warns when NOT VALID is present (index still may be missing)', () => {
    const sql = 'ALTER TABLE orders ADD CONSTRAINT fk_customer FOREIGN KEY (customer_id) REFERENCES customers(id) NOT VALID;';
    const res = analyzeSql(sql, { rules: [unindexedForeignKeyRule] });
    assert.strictEqual(res.warningsCount, 1);
    assert.strictEqual(res.findings[0].ruleId, 'unindexed-foreign-key');
  });

  it('passes when ignored with directive comment', () => {
    const sql = `-- ddlforge-ignore unindexed-foreign-key\nALTER TABLE orders ADD CONSTRAINT fk_customer FOREIGN KEY (customer_id) REFERENCES customers(id);`;
    const res = analyzeSql(sql, { rules: [unindexedForeignKeyRule] });
    assert.strictEqual(res.findings.length, 0);
  });

  it('detects multiple FOREIGN KEY clauses in one statement', () => {
    const sql = `ALTER TABLE shipments
      ADD CONSTRAINT fk_order FOREIGN KEY (order_id) REFERENCES orders(id),
      ADD CONSTRAINT fk_carrier FOREIGN KEY (carrier_id) REFERENCES carriers(id);`;
    const res = analyzeSql(sql, { rules: [unindexedForeignKeyRule] });
    assert.strictEqual(res.warningsCount, 2);
  });

  it('includes referencing columns in suggestion', () => {
    const sql = 'ALTER TABLE orders ADD CONSTRAINT fk_cust FOREIGN KEY (customer_id) REFERENCES customers(id);';
    const res = analyzeSql(sql, { rules: [unindexedForeignKeyRule] });
    assert.ok(res.findings[0].suggestion.includes('customer_id'));
  });
});

// ---------------------------------------------------------------------------
// Rule 13: dropColumnLock (drop-column-lock)
// ---------------------------------------------------------------------------

describe('Rule 13: dropColumnLock (drop-column-lock)', () => {
  it('detects DROP COLUMN as WARNING with ACCESS EXCLUSIVE lock', () => {
    const sql = 'ALTER TABLE users DROP COLUMN email;';
    const res = analyzeSql(sql, { rules: [dropColumnLockRule] });
    assert.strictEqual(res.warningsCount, 1);
    const f = res.findings[0];
    assert.strictEqual(f.ruleId, 'drop-column-lock');
    assert.strictEqual(f.severity, 'WARNING');
    assert.ok(f.message.includes('"email"'));
    assert.ok(f.message.includes('"users"'));
    assert.ok(f.suggestion.includes('RENAME COLUMN'));
  });

  it('detects DROP COLUMN IF EXISTS as WARNING', () => {
    const sql = 'ALTER TABLE users DROP COLUMN IF EXISTS email;';
    const res = analyzeSql(sql, { rules: [dropColumnLockRule] });
    assert.strictEqual(res.warningsCount, 1);
    assert.ok(res.findings[0].message.includes('"email"'));
  });

  it('passes ALTER TABLE ... ADD COLUMN (no DROP COLUMN)', () => {
    const sql = 'ALTER TABLE users ADD COLUMN foo text;';
    const res = analyzeSql(sql, { rules: [dropColumnLockRule] });
    assert.strictEqual(res.findings.length, 0);
  });

  it('detects multiple DROP COLUMNs in one statement as 2 findings', () => {
    const sql = 'ALTER TABLE t DROP COLUMN a, DROP COLUMN b;';
    const res = analyzeSql(sql, { rules: [dropColumnLockRule] });
    assert.strictEqual(res.warningsCount, 2);
    assert.ok(res.findings[0].message.includes('"a"'));
    assert.ok(res.findings[1].message.includes('"b"'));
  });

  it('passes when ignored with directive comment', () => {
    const sql = `-- ddlforge-ignore drop-column-lock\nALTER TABLE users DROP COLUMN email;`;
    const res = analyzeSql(sql, { rules: [dropColumnLockRule] });
    assert.strictEqual(res.findings.length, 0);
  });
});

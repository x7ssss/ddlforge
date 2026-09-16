/**
 * ddlforge - Unit tests for rules 8, 9, 10 (check-constraint-not-valid,
 * unique-constraint-using-index, session-advisory-lock) and fixture verification.
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

/**
 * ddlforge — test/waivers.test.ts
 *
 * Unit tests for statement-level inline waivers:
 *   -- ddlforge-disable-next-line <rule-id> reason="<mandatory-reason>" [expires="YYYY-MM-DD"]
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { analyzeSql, formatSarif, formatTerminal } from '../src/index.js';
import { dropColumnLockRule, addColumnNotNullRule, indexConcurrentlyRule, foreignKeyNotValidRule } from '../src/rules/index.js';

describe('Statement-Level Inline Waivers', () => {
  describe('a) Valid inline waivers suppressing ACCESS EXCLUSIVE locks', () => {
    it('suppresses ACCESS EXCLUSIVE lock using lock-access-exclusive rule ID', () => {
      const sql = `
-- ddlforge-disable-next-line lock-access-exclusive reason="Planned maintenance window deploy"
ALTER TABLE users DROP COLUMN phone;
      `;
      const res = analyzeSql(sql);

      assert.strictEqual(res.blockersCount, 0, 'Expected 0 blockers');
      assert.strictEqual(res.warningsCount, 0, 'Expected 0 warnings (drop-column-lock suppressed)');
      assert.strictEqual(res.hasBlockers, false);
      assert.strictEqual(res.exitCode, 0);
      assert.strictEqual(res.findings.length, 0, 'Active findings should be empty');
      assert.strictEqual(res.suppressedFindings.length, 1, 'Expected 1 suppressed finding');
      assert.strictEqual(res.suppressedFindings[0].suppressed, true);
      assert.strictEqual(res.suppressedFindings[0].waiverReason, 'Planned maintenance window deploy');
      assert.strictEqual(res.suppressedFindings[0].ruleId, 'drop-column-lock');
    });

    it('suppresses ACCESS EXCLUSIVE lock using exact rule ID (drop-column-lock)', () => {
      const sql = `
-- ddlforge-disable-next-line drop-column-lock reason="Approved by DBA for scheduled downtime"
ALTER TABLE users DROP COLUMN phone;
      `;
      const res = analyzeSql(sql);

      assert.strictEqual(res.blockersCount, 0);
      assert.strictEqual(res.hasBlockers, false);
      assert.strictEqual(res.findings.length, 0);
      assert.strictEqual(res.suppressedFindings.length, 1);
      assert.strictEqual(res.suppressedFindings[0].ruleId, 'drop-column-lock');
    });

    it('suppresses ACCESS EXCLUSIVE lock on ADD COLUMN NOT NULL without default', () => {
      const sql = `
-- ddlforge-disable-next-line lock-access-exclusive reason="Initial table bootstrap before traffic"
ALTER TABLE accounts ADD COLUMN status text NOT NULL;
      `;
      const res = analyzeSql(sql);

      assert.strictEqual(res.blockersCount, 0);
      assert.strictEqual(res.hasBlockers, false);
      assert.strictEqual(res.findings.length, 0);
      assert.strictEqual(res.suppressedFindings.length, 1);
      assert.strictEqual(res.suppressedFindings[0].ruleId, 'add-column-not-null-without-default');
    });

    it('retains full SARIF output compatibility with suppressions: [{ kind: "inSource" }]', () => {
      const sql = `
-- ddlforge-disable-next-line lock-access-exclusive reason="Approved maintenance window"
ALTER TABLE users DROP COLUMN phone;
      `;
      const res = analyzeSql(sql);
      const sarifJson = formatSarif([res]);
      const sarif = JSON.parse(sarifJson);

      assert.ok(sarif.runs && sarif.runs.length > 0);
      const run = sarif.runs[0];
      assert.strictEqual(run.results.length, 1);

      const result = run.results[0];
      assert.strictEqual(result.ruleId, 'drop-column-lock');
      assert.ok(Array.isArray(result.suppressions), 'Expected suppressions array in SARIF result');
      assert.strictEqual(result.suppressions.length, 1);
      assert.deepStrictEqual(result.suppressions[0], { kind: 'inSource' });
    });
  });

  describe('b) Waivers failing due to missing/short reason string', () => {
    it('fails when reason attribute is completely missing', () => {
      const sql = `
-- ddlforge-disable-next-line lock-access-exclusive
ALTER TABLE users DROP COLUMN phone;
      `;
      const res = analyzeSql(sql);

      assert.strictEqual(res.hasBlockers, true);
      assert.strictEqual(res.exitCode, 1);
      const invalidWaiver = res.findings.find(f => f.ruleId === 'INVALID_WAIVER');
      assert.ok(invalidWaiver, 'Expected INVALID_WAIVER finding');
      assert.strictEqual(invalidWaiver.severity, 'BLOCKER');
      assert.ok(invalidWaiver.message.includes('missing mandatory reason'));

      // Underlying violation must NOT be suppressed
      const dropColFinding = res.findings.find(f => f.ruleId === 'drop-column-lock');
      assert.ok(dropColFinding, 'Expected original finding to not be suppressed');
      assert.strictEqual(res.suppressedFindings.length, 0);
    });

    it('fails when reason attribute is empty string', () => {
      const sql = `
-- ddlforge-disable-next-line lock-access-exclusive reason=""
ALTER TABLE users DROP COLUMN phone;
      `;
      const res = analyzeSql(sql);

      assert.strictEqual(res.hasBlockers, true);
      assert.strictEqual(res.exitCode, 1);
      const invalidWaiver = res.findings.find(f => f.ruleId === 'INVALID_WAIVER');
      assert.ok(invalidWaiver);
      assert.strictEqual(invalidWaiver.severity, 'BLOCKER');
    });

    it('fails when reason attribute is shorter than 8 characters', () => {
      const sql = `
-- ddlforge-disable-next-line require-concurrent-index reason="testing"
CREATE INDEX idx_users_name ON users (name);
      `;
      const res = analyzeSql(sql);

      assert.strictEqual(res.hasBlockers, true);
      assert.strictEqual(res.exitCode, 1);
      const invalidWaiver = res.findings.find(f => f.ruleId === 'INVALID_WAIVER');
      assert.ok(invalidWaiver, 'Expected INVALID_WAIVER finding for 7-char reason');
      assert.strictEqual(invalidWaiver.severity, 'BLOCKER');
      assert.ok(invalidWaiver.message.includes('shorter than 8 characters'));

      // Original rule finding must NOT be suppressed
      const idxFinding = res.findings.find(f => f.ruleId === 'require-concurrent-index');
      assert.ok(idxFinding, 'Expected require-concurrent-index finding to remain active');
      assert.strictEqual(res.suppressedFindings.length, 0);
    });

    it('accepts reason attribute with exactly 8 characters or more', () => {
      const sql = `
-- ddlforge-disable-next-line require-concurrent-index reason="12345678"
CREATE INDEX idx_users_name ON users (name);
      `;
      const res = analyzeSql(sql);

      assert.strictEqual(res.blockersCount, 0);
      assert.strictEqual(res.hasBlockers, false);
      assert.strictEqual(res.findings.length, 0);
      assert.strictEqual(res.suppressedFindings.length, 1);
    });
  });

  describe('c) Waivers failing due to expired date', () => {
    it('ignores suppression, emits EXPIRED_WAIVER error, and fails lint check when expired', () => {
      const sql = `
-- ddlforge-disable-next-line require-concurrent-index reason="Temporary waiver for incident 123" expires="2020-01-01"
CREATE INDEX idx_orders_customer ON orders (customer_id);
      `;
      const res = analyzeSql(sql);

      assert.strictEqual(res.hasBlockers, true, 'Lint check must fail');
      assert.strictEqual(res.exitCode, 1, 'Exit code must be 1');

      const expiredWaiver = res.findings.find(f => f.ruleId === 'EXPIRED_WAIVER');
      assert.ok(expiredWaiver, 'Expected EXPIRED_WAIVER error finding');
      assert.strictEqual(expiredWaiver.severity, 'BLOCKER');
      assert.ok(expiredWaiver.message.includes('expired on 2020-01-01'));

      // Underlying violation must NOT be suppressed
      const indexFinding = res.findings.find(f => f.ruleId === 'require-concurrent-index');
      assert.ok(indexFinding, 'Underlying finding must remain active');
      assert.strictEqual(res.suppressedFindings.length, 0);
    });

    it('succeeds when expiration date is in the future', () => {
      const sql = `
-- ddlforge-disable-next-line require-concurrent-index reason="Temporary approved exception" expires="2099-12-31"
CREATE INDEX idx_orders_customer ON orders (customer_id);
      `;
      const res = analyzeSql(sql);

      assert.strictEqual(res.blockersCount, 0);
      assert.strictEqual(res.hasBlockers, false);
      assert.strictEqual(res.exitCode, 0);
      assert.strictEqual(res.findings.length, 0);
      assert.strictEqual(res.suppressedFindings.length, 1);
    });

    it('respects currentDate option for deterministic testing', () => {
      const sql = `
-- ddlforge-disable-next-line require-concurrent-index reason="Approved until May 2026" expires="2026-05-01"
CREATE INDEX idx_test ON test (id);
      `;

      // When tested before expiration date
      const beforeRes = analyzeSql(sql, { currentDate: new Date('2026-04-15') });
      assert.strictEqual(beforeRes.hasBlockers, false);
      assert.strictEqual(beforeRes.suppressedFindings.length, 1);

      // When tested after expiration date
      const afterRes = analyzeSql(sql, { currentDate: new Date('2026-05-02') });
      assert.strictEqual(afterRes.hasBlockers, true);
      assert.ok(afterRes.findings.some(f => f.ruleId === 'EXPIRED_WAIVER'));
    });
  });

  describe('d) Multi-statement files ensuring disable-next-line only suppresses the single target statement', () => {
    it('suppresses only statement 2 and does not bleed to statement 3 or 1', () => {
      const sql = `
ALTER TABLE t1 DROP COLUMN col1;

-- ddlforge-disable-next-line drop-column-lock reason="Approved target migration only"
ALTER TABLE t2 DROP COLUMN col2;

ALTER TABLE t3 DROP COLUMN col3;
      `;
      const res = analyzeSql(sql);

      // t1 and t3 should produce warnings, t2 should be suppressed
      assert.strictEqual(res.findings.length, 2, 'Expected exactly 2 active findings (t1 and t3)');
      assert.strictEqual(res.suppressedFindings.length, 1, 'Expected 1 suppressed finding (t2)');

      const t1Finding = res.findings.find(f => f.codeSnippet.includes('t1'));
      assert.ok(t1Finding, 'Expected active finding for t1');

      const t3Finding = res.findings.find(f => f.codeSnippet.includes('t3'));
      assert.ok(t3Finding, 'Expected active finding for t3');

      assert.ok(res.suppressedFindings[0].codeSnippet.includes('t2'), 'Expected suppressed finding for t2');
    });

    it('suppresses statement 1 without bleeding to statement 2', () => {
      const sql = `
-- ddlforge-disable-next-line require-concurrent-index reason="Initial index build"
CREATE INDEX idx_a ON t (a);

CREATE INDEX idx_b ON t (b);
      `;
      const res = analyzeSql(sql);

      assert.strictEqual(res.findings.length, 1, 'Expected 1 active finding (idx_b)');
      assert.ok(res.findings[0].codeSnippet.includes('idx_b'));
      assert.strictEqual(res.suppressedFindings.length, 1, 'Expected 1 suppressed finding (idx_a)');
      assert.ok(res.suppressedFindings[0].codeSnippet.includes('idx_a'));
    });

    it('handles multiple waivers directly preceding a single statement', () => {
      const sql = `
-- ddlforge-disable-next-line drop-column-lock reason="Approved dropping old col"
-- ddlforge-disable-next-line add-column-not-null-without-default reason="Approved adding new col"
-- ddlforge-disable-next-line prisma-silent-rename-data-loss reason="Intentional replacement of field"
ALTER TABLE users DROP COLUMN old_col, ADD COLUMN new_col integer NOT NULL;
      `;
      const res = analyzeSql(sql);

      assert.strictEqual(res.hasBlockers, false);
      assert.strictEqual(res.findings.length, 0);
      assert.strictEqual(res.suppressedFindings.length, 3);
    });

    it('supports rule aliases like non-concurrent-index and unvalidated-foreign-key', () => {
      const sqlIndex = `
-- ddlforge-disable-next-line non-concurrent-index reason="Batch index creation"
CREATE INDEX idx_test ON test (col);
      `;
      const resIndex = analyzeSql(sqlIndex);
      assert.strictEqual(resIndex.hasBlockers, false);
      assert.strictEqual(resIndex.suppressedFindings.length, 1);
      assert.strictEqual(resIndex.suppressedFindings[0].ruleId, 'require-concurrent-index');

      const sqlFk = `
-- ddlforge-disable-next-line unvalidated-foreign-key reason="Pre-validated reference table"
ALTER TABLE orders ADD CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id);
      `;
      const resFk = analyzeSql(sqlFk);
      // foreign-key-missing-not-valid (BLOCKER) is suppressed, leaving unindexed-foreign-key (WARNING)
      assert.strictEqual(resFk.blockersCount, 0);
      assert.strictEqual(resFk.hasBlockers, false);
      assert.strictEqual(resFk.suppressedFindings.length, 1);
      assert.strictEqual(resFk.suppressedFindings[0].ruleId, 'foreign-key-missing-not-valid');
    });
  });
});

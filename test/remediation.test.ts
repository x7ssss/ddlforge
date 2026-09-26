/**
 * ddlforge — test/remediation.test.ts
 *
 * Comprehensive tests for automated zero-downtime remediation generator engine
 * and reporter integration (--suggest-fix flag).
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  generateIndexConcurrentlyRemediation,
  generateForeignKeyRemediation,
  generateSetNotNullRemediation,
  generateAddColumnNotNullRemediation,
  generateRemediation,
  attachRemediations,
} from '../src/engine/remediation.js';
import { analyzeSql } from '../src/engine/analyzer.js';
import { parseArgs } from '../src/cli.js';
import { formatTerminal } from '../src/reporters/terminal.js';
import { formatGithub, generateStepSummary } from '../src/reporters/github.js';

describe('Zero-Downtime Remediation Generator Engine', () => {
  describe('a) Non-concurrent index remediation', () => {
    it('generates Phase 1 CONCURRENTLY modifier with transaction reminder for standard index', () => {
      const sql = 'CREATE INDEX idx_users_email ON users (email);';
      const rem = generateIndexConcurrentlyRemediation(sql);

      assert.ok(rem.includes('Phase 1'), 'Must include Phase 1 marker');
      assert.ok(rem.includes('CREATE INDEX CONCURRENTLY idx_users_email ON users (email);'));
      assert.ok(rem.includes('outside transaction blocks'), 'Must include reminder to run outside transaction blocks');
    });

    it('generates Phase 1 CONCURRENTLY for unique index', () => {
      const sql = 'CREATE UNIQUE INDEX idx_users_email ON users (email);';
      const rem = generateIndexConcurrentlyRemediation(sql);

      assert.ok(rem.includes('CREATE UNIQUE INDEX CONCURRENTLY idx_users_email ON users (email);'));
      assert.ok(rem.includes('outside transaction blocks'));
    });

    it('generates Phase 1 CONCURRENTLY for multi-column index', () => {
      const sql = 'CREATE INDEX idx_orders_user_created ON orders (user_id, created_at);';
      const rem = generateIndexConcurrentlyRemediation(sql);

      assert.ok(rem.includes('CREATE INDEX CONCURRENTLY idx_orders_user_created ON orders (user_id, created_at);'));
    });
  });

  describe('b) Unvalidated Foreign Key remediation', () => {
    it('generates Phase 1 NOT VALID and Phase 2 VALIDATE CONSTRAINT', () => {
      const sql = 'ALTER TABLE orders ADD CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users (id);';
      const rem = generateForeignKeyRemediation(sql);

      assert.ok(rem.includes('Phase 1: Add foreign key constraint as NOT VALID'));
      assert.ok(rem.includes('ALTER TABLE orders ADD CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users (id) NOT VALID;'));
      assert.ok(rem.includes('Phase 2: Validate foreign key constraint in isolation'));
      assert.ok(rem.includes('ALTER TABLE orders VALIDATE CONSTRAINT fk_user;'));
    });

    it('generates synthesized constraint name when unnamed in original statement', () => {
      const sql = 'ALTER TABLE orders ADD FOREIGN KEY (user_id) REFERENCES users (id);';
      const rem = generateForeignKeyRemediation(sql);

      assert.ok(rem.includes('ALTER TABLE orders ADD CONSTRAINT fk_orders_user_id FOREIGN KEY (user_id) REFERENCES users (id) NOT VALID;'));
      assert.ok(rem.includes('ALTER TABLE orders VALIDATE CONSTRAINT fk_orders_user_id;'));
    });
  });

  describe('c) Unsafe NOT NULL on existing populated column remediation', () => {
    it('generates 4-phase safe NOT NULL pattern with chk_<col>_not_null', () => {
      const sql = 'ALTER TABLE users ALTER COLUMN email SET NOT NULL;';
      const rem = generateSetNotNullRemediation(sql);

      // Phase 1: ADD CONSTRAINT chk_<col>_not_null CHECK (<col> IS NOT NULL) NOT VALID
      assert.ok(rem.includes('Phase 1'));
      assert.ok(rem.includes('ALTER TABLE users ADD CONSTRAINT chk_email_not_null CHECK (email IS NOT NULL) NOT VALID;'));

      // Phase 2: VALIDATE CONSTRAINT chk_<col>_not_null
      assert.ok(rem.includes('Phase 2'));
      assert.ok(rem.includes('ALTER TABLE users VALIDATE CONSTRAINT chk_email_not_null;'));

      // Phase 3: ALTER COLUMN <col> SET NOT NULL
      assert.ok(rem.includes('Phase 3'));
      assert.ok(rem.includes('ALTER TABLE users ALTER COLUMN email SET NOT NULL;'));

      // Phase 4: DROP CONSTRAINT chk_<col>_not_null
      assert.ok(rem.includes('Phase 4'));
      assert.ok(rem.includes('ALTER TABLE users DROP CONSTRAINT chk_email_not_null;'));
    });

    it('handles quoted identifiers cleanly in NOT NULL remediation', () => {
      const sql = 'ALTER TABLE ONLY "accounts" ALTER COLUMN "balance" SET NOT NULL;';
      const rem = generateSetNotNullRemediation(sql);

      assert.ok(rem.includes('ALTER TABLE accounts ADD CONSTRAINT chk_balance_not_null CHECK (balance IS NOT NULL) NOT VALID;'));
      assert.ok(rem.includes('ALTER TABLE accounts VALIDATE CONSTRAINT chk_balance_not_null;'));
      assert.ok(rem.includes('ALTER TABLE accounts ALTER COLUMN balance SET NOT NULL;'));
      assert.ok(rem.includes('ALTER TABLE accounts DROP CONSTRAINT chk_balance_not_null;'));
    });
  });

  describe('d) Adding column with non-constant DEFAULT / NOT NULL', () => {
    it('generates 3-phase remediation: nullable -> batch backfill -> validated constraint', () => {
      const sql = 'ALTER TABLE users ADD COLUMN age INT NOT NULL;';
      const rem = generateAddColumnNotNullRemediation(sql);

      // Phase 1: Add column nullable without default
      assert.ok(rem.includes('Phase 1: Add column nullable without default'));
      assert.ok(rem.includes('ALTER TABLE users ADD COLUMN age INT;'));

      // Phase 2: Backfill data in asynchronous batches
      assert.ok(rem.includes('Phase 2: Backfill data in asynchronous batches'));
      assert.ok(rem.includes('LIMIT 5000'));
      assert.ok(rem.includes('PERFORM pg_sleep(0.1);'));

      // Phase 3: Set default for future rows & attach constraint via NOT VALID -> VALIDATE
      assert.ok(rem.includes('Phase 3'));
      assert.ok(rem.includes('ALTER TABLE users ADD CONSTRAINT chk_age_not_null CHECK (age IS NOT NULL) NOT VALID;'));
      assert.ok(rem.includes('ALTER TABLE users VALIDATE CONSTRAINT chk_age_not_null;'));
      assert.ok(rem.includes('ALTER TABLE users ALTER COLUMN age SET NOT NULL;'));
      assert.ok(rem.includes('ALTER TABLE users DROP CONSTRAINT chk_age_not_null;'));
    });

    it('handles column with default value properly in backfill and future rows', () => {
      const sql = "ALTER TABLE orders ADD COLUMN status VARCHAR(32) NOT NULL DEFAULT 'pending';";
      const rem = generateAddColumnNotNullRemediation(sql);

      assert.ok(rem.includes('ALTER TABLE orders ADD COLUMN status VARCHAR(32);'));
      assert.ok(rem.includes("SET status = 'pending'"));
      assert.ok(rem.includes("ALTER TABLE orders ALTER COLUMN status SET DEFAULT 'pending';"));
      assert.ok(rem.includes('ALTER TABLE orders ADD CONSTRAINT chk_status_not_null CHECK (status IS NOT NULL) NOT VALID;'));
      assert.ok(rem.includes('ALTER TABLE orders VALIDATE CONSTRAINT chk_status_not_null;'));
    });
  });
});

describe('CLI & Reporter Integration (--suggest-fix)', () => {
  it('parses --suggest-fix flag in parseArgs', () => {
    const opts = parseArgs(['check', './migrations', '--suggest-fix']);
    assert.strictEqual(opts.suggestFix, true);

    const defaultOpts = parseArgs(['check', './migrations']);
    assert.strictEqual(defaultOpts.suggestFix, false);
  });

  it('prints 💡 Recommended Safe Fix beneath violation in terminal output when suggestFix is true', () => {
    const sql = 'CREATE INDEX idx_users_email ON users (email);';
    const res = analyzeSql(sql, { filePath: 'migrations/001.sql' });
    assert.strictEqual(res.hasBlockers, true);

    const outputWithFix = formatTerminal([res], { suggestFix: true, color: false });
    assert.ok(outputWithFix.includes('💡 Recommended Safe Fix:'));
    assert.ok(outputWithFix.includes('CREATE INDEX CONCURRENTLY idx_users_email ON users (email);'));
  });

  it('includes 💡 Recommended Safe Fix codeblock in formatGithub when suggestFix is active', () => {
    const sql = 'CREATE INDEX idx_users_email ON users (email);';
    const res = analyzeSql(sql, { filePath: 'migrations/001.sql' });

    const output = formatGithub([res], { suggestFix: true, dangerousLockTitle: true });
    assert.ok(output.includes('::error '));
    assert.ok(output.includes('%0A%0A💡 Recommended Safe Fix:%0A```sql%0A'));
    assert.ok(output.includes('CREATE INDEX CONCURRENTLY'));
  });

  it('includes 💡 Recommended Safe Fix codeblock in generateStepSummary', () => {
    const sql = `
CREATE INDEX idx_users_email ON users (email);
ALTER TABLE orders ADD CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id);
    `;
    const res = analyzeSql(sql, { filePath: 'migrations/001_init.sql' });

    const summary = generateStepSummary([res], { suggestFix: true });
    assert.ok(summary.includes('### ddlforge Migration Safety Summary'));
    assert.ok(summary.includes('| File | Line | Statement | Lock Type | Downtime Risk | Recommended Fix |'));
    assert.ok(summary.includes('### 💡 Recommended Safe Fix'));
    assert.ok(summary.includes('```sql'));
    assert.ok(summary.includes('CREATE INDEX CONCURRENTLY'));
    assert.ok(summary.includes('ALTER TABLE orders ADD CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users (id) NOT VALID;'));
  });
});

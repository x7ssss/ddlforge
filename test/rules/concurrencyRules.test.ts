/**
 * ddlforge - Comprehensive unit and adversarial tests for PostgreSQL 15-17 concurrency rules
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { analyzeSql, PostgresLockLevel } from '../../src/index.js';
import { runCli } from '../../src/cli.js';
import {
  addPrimaryKeyMissingUsingIndexRule,
  checkConstraintMissingNotValidRule,
  detachPartitionNonConcurrentRule,
  reindexMissingConcurrentlyRule,
  enumAddValueInTransactionRule,
  maintenanceCommandDetectedRule,
} from '../../src/rules/index.js';

/* ────────────────────────────────────────────────────────────────────────── */
/* Rule 1: add-primary-key-missing-using-index                                */
/* ────────────────────────────────────────────────────────────────────────── */

describe('Rule: add-primary-key-missing-using-index', () => {
  it('detects ALTER TABLE ADD PRIMARY KEY as BLOCKER with ACCESS EXCLUSIVE lock', () => {
    const sql = 'ALTER TABLE users ADD PRIMARY KEY (id);';
    const res = analyzeSql(sql, { rules: [addPrimaryKeyMissingUsingIndexRule] });
    assert.strictEqual(res.blockersCount, 1);
    const f = res.findings[0];
    assert.strictEqual(f.ruleId, 'add-primary-key-missing-using-index');
    assert.strictEqual(f.severity, 'BLOCKER');
    assert.strictEqual(f.lockLevel, PostgresLockLevel.ACCESS_EXCLUSIVE);
    assert.ok(f.message.includes('"users"'));
    assert.ok(f.suggestion.includes('CREATE UNIQUE INDEX CONCURRENTLY'));
    assert.ok(f.suggestion.includes('PRIMARY KEY USING INDEX'));
    assert.ok(f.remediation?.includes('CREATE UNIQUE INDEX CONCURRENTLY'));
  });

  it('detects ALTER TABLE ADD CONSTRAINT ... PRIMARY KEY as BLOCKER', () => {
    const sql = 'ALTER TABLE orders ADD CONSTRAINT pk_orders PRIMARY KEY (order_id);';
    const res = analyzeSql(sql, { rules: [addPrimaryKeyMissingUsingIndexRule] });
    assert.strictEqual(res.blockersCount, 1);
    const f = res.findings[0];
    assert.ok(f.message.includes('"pk_orders"'));
    assert.ok(f.message.includes('"orders"'));
  });

  it('detects composite PRIMARY KEY without USING INDEX', () => {
    const sql = 'ALTER TABLE order_items ADD CONSTRAINT pk_order_items PRIMARY KEY (order_id, line_no);';
    const res = analyzeSql(sql, { rules: [addPrimaryKeyMissingUsingIndexRule] });
    assert.strictEqual(res.blockersCount, 1);
    assert.ok(res.findings[0].suggestion.includes('order_id, line_no'));
  });

  it('handles ONLY and IF EXISTS table modifiers', () => {
    const sql = 'ALTER TABLE IF EXISTS ONLY accounts ADD PRIMARY KEY (account_id);';
    const res = analyzeSql(sql, { rules: [addPrimaryKeyMissingUsingIndexRule] });
    assert.strictEqual(res.blockersCount, 1);
    assert.ok(res.findings[0].message.includes('"accounts"'));
  });

  it('passes ALTER TABLE ADD PRIMARY KEY USING INDEX', () => {
    const sql = 'ALTER TABLE users ADD PRIMARY KEY USING INDEX idx_users_pk;';
    const res = analyzeSql(sql, { rules: [addPrimaryKeyMissingUsingIndexRule] });
    assert.strictEqual(res.blockersCount, 0);
    assert.strictEqual(res.findings.length, 0);
  });

  it('passes ALTER TABLE ADD CONSTRAINT ... PRIMARY KEY USING INDEX', () => {
    const sql = 'ALTER TABLE users ADD CONSTRAINT pk_users PRIMARY KEY USING INDEX idx_users_pk;';
    const res = analyzeSql(sql, { rules: [addPrimaryKeyMissingUsingIndexRule] });
    assert.strictEqual(res.blockersCount, 0);
    assert.strictEqual(res.findings.length, 0);
  });

  it('does not flag CREATE TABLE with inline PRIMARY KEY', () => {
    const sql = 'CREATE TABLE users (id SERIAL PRIMARY KEY, name TEXT);';
    const res = analyzeSql(sql, { rules: [addPrimaryKeyMissingUsingIndexRule] });
    assert.strictEqual(res.blockersCount, 0);
  });

  it('detects bare ADD PRIMARY KEY (id) on orders as BLOCKER in analyzeSql (default rules)', () => {
    const sql = 'ALTER TABLE orders ADD PRIMARY KEY (id);';
    const res = analyzeSql(sql);
    assert.strictEqual(res.blockersCount, 1);
    const f = res.findings[0];
    assert.strictEqual(f.ruleId, 'add-primary-key-missing-using-index');
    assert.strictEqual(f.severity, 'BLOCKER');
    assert.ok(f.message.includes('"orders"'));
    assert.ok(f.suggestion.includes('CREATE UNIQUE INDEX CONCURRENTLY'));
    assert.ok(f.suggestion.includes('PRIMARY KEY USING INDEX'));
  });

  it('detects named ADD CONSTRAINT orders_pkey PRIMARY KEY (id) on orders as BLOCKER in analyzeSql (default rules)', () => {
    const sql = 'ALTER TABLE orders ADD CONSTRAINT orders_pkey PRIMARY KEY (id);';
    const res = analyzeSql(sql);
    assert.strictEqual(res.blockersCount, 1);
    const f = res.findings[0];
    assert.strictEqual(f.ruleId, 'add-primary-key-missing-using-index');
    assert.strictEqual(f.severity, 'BLOCKER');
    assert.ok(f.message.includes('"orders_pkey"'));
    assert.ok(f.message.includes('"orders"'));
    assert.ok(f.suggestion.includes('orders_pkey'));
  });

  it('detects schema-qualified ALTER TABLE public.orders ADD PRIMARY KEY (id)', () => {
    const sql = 'ALTER TABLE public.orders ADD PRIMARY KEY (id);';
    const res = analyzeSql(sql);
    assert.strictEqual(res.blockersCount, 1);
    const f = res.findings[0];
    assert.strictEqual(f.ruleId, 'add-primary-key-missing-using-index');
    assert.ok(f.message.includes('"public.orders"'));
  });

  it('detects schema-qualified ALTER TABLE public.orders ADD CONSTRAINT orders_pkey PRIMARY KEY (id)', () => {
    const sql = 'ALTER TABLE public.orders ADD CONSTRAINT orders_pkey PRIMARY KEY (id);';
    const res = analyzeSql(sql);
    assert.strictEqual(res.blockersCount, 1);
    const f = res.findings[0];
    assert.ok(f.message.includes('"orders_pkey"'));
    assert.ok(f.message.includes('"public.orders"'));
  });

  it('detects ALTER TABLE ONLY orders ADD PRIMARY KEY (id)', () => {
    const sql = 'ALTER TABLE ONLY orders ADD PRIMARY KEY (id);';
    const res = analyzeSql(sql);
    assert.strictEqual(res.blockersCount, 1);
    assert.ok(res.findings[0].message.includes('"orders"'));
  });

  it('detects ALTER TABLE ONLY public.orders ADD CONSTRAINT orders_pkey PRIMARY KEY (id)', () => {
    const sql = 'ALTER TABLE ONLY public.orders ADD CONSTRAINT orders_pkey PRIMARY KEY (id);';
    const res = analyzeSql(sql);
    assert.strictEqual(res.blockersCount, 1);
    assert.ok(res.findings[0].message.includes('"orders_pkey"'));
    assert.ok(res.findings[0].message.includes('"public.orders"'));
  });

  it('detects quoted schema-qualified ALTER TABLE "public"."orders" ADD PRIMARY KEY (id)', () => {
    const sql = 'ALTER TABLE "public"."orders" ADD PRIMARY KEY (id);';
    const res = analyzeSql(sql);
    assert.strictEqual(res.blockersCount, 1);
    assert.ok(res.findings[0].message.includes('"public"."orders"'));
  });

  it('specifically checks ALTER TABLE orders ADD PRIMARY KEY (id); and asserts that it produces a blocker', () => {
    const sql = 'ALTER TABLE orders ADD PRIMARY KEY (id);';
    const res = analyzeSql(sql);
    assert.strictEqual(res.blockersCount, 1);
    assert.strictEqual(res.hasBlockers, true);
    assert.strictEqual(res.findings.length, 1);
    const f = res.findings[0];
    assert.strictEqual(f.ruleId, 'add-primary-key-missing-using-index');
    assert.strictEqual(f.severity, 'BLOCKER');
    assert.strictEqual(f.lockLevel, PostgresLockLevel.ACCESS_EXCLUSIVE);
    assert.strictEqual(
      f.message,
      'PRIMARY KEY constraint on table "orders" added without USING INDEX.'
    );
    assert.ok(f.suggestion.includes('CREATE UNIQUE INDEX CONCURRENTLY orders_pkey_idx ON orders (id);'));
    assert.ok(f.suggestion.includes('ALTER TABLE orders ADD CONSTRAINT orders_pkey PRIMARY KEY USING INDEX orders_pkey_idx;'));
  });

  it('correctly tokenizes and analyzes a statement prefixed with a UTF-8 BOM (\\uFEFF)', () => {
    const sql = '\uFEFFALTER TABLE orders ADD PRIMARY KEY (id);';
    const res = analyzeSql(sql);
    assert.strictEqual(res.blockersCount, 1);
    assert.strictEqual(res.hasBlockers, true);
    assert.strictEqual(res.findings.length, 1);
    const f = res.findings[0];
    assert.strictEqual(f.ruleId, 'add-primary-key-missing-using-index');
    assert.strictEqual(f.severity, 'BLOCKER');
    assert.strictEqual(f.lockLevel, PostgresLockLevel.ACCESS_EXCLUSIVE);
    assert.strictEqual(
      f.message,
      'PRIMARY KEY constraint on table "orders" added without USING INDEX.'
    );
  });

  it('verifies running ddlforge check CLI on a file containing ALTER TABLE orders ADD PRIMARY KEY (id); outputs a BLOCKER and exitCode 1', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddlforge-cli-pk-'));
    const tmpFile = path.join(tmpDir, 'migration.sql');
    try {
      fs.writeFileSync(tmpFile, 'ALTER TABLE orders ADD PRIMARY KEY (id);', 'utf-8');
      const exitCode = await runCli(['check', tmpFile, '--format', 'terminal']);
      assert.strictEqual(exitCode, 1, 'CLI check should return exit code 1 when blocker is detected');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('passes when ignored with directive comment', () => {
    const sql = `-- ddlforge-ignore add-primary-key-missing-using-index\nALTER TABLE orders ADD PRIMARY KEY (id);`;
    const res = analyzeSql(sql, { rules: [addPrimaryKeyMissingUsingIndexRule] });
    assert.strictEqual(res.findings.length, 0);
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* Rule 2: check-constraint-missing-not-valid                                 */
/* ────────────────────────────────────────────────────────────────────────── */

describe('Rule: check-constraint-missing-not-valid', () => {
  it('detects ADD CONSTRAINT CHECK without NOT VALID as BLOCKER', () => {
    const sql = 'ALTER TABLE products ADD CONSTRAINT chk_price CHECK (price >= 0);';
    const res = analyzeSql(sql, { rules: [checkConstraintMissingNotValidRule] });
    assert.strictEqual(res.blockersCount, 1);
    const f = res.findings[0];
    assert.strictEqual(f.ruleId, 'check-constraint-missing-not-valid');
    assert.strictEqual(f.severity, 'BLOCKER');
    assert.strictEqual(f.lockLevel, PostgresLockLevel.ACCESS_EXCLUSIVE);
    assert.ok(f.suggestion.includes('NOT VALID'));
    assert.ok(f.suggestion.includes('VALIDATE CONSTRAINT'));
  });

  it('detects anonymous ADD CHECK without NOT VALID as BLOCKER', () => {
    const sql = 'ALTER TABLE products ADD CHECK (quantity >= 0);';
    const res = analyzeSql(sql, { rules: [checkConstraintMissingNotValidRule] });
    assert.strictEqual(res.blockersCount, 1);
    assert.strictEqual(res.findings[0].ruleId, 'check-constraint-missing-not-valid');
  });

  it('passes ADD CONSTRAINT CHECK ... NOT VALID', () => {
    const sql = 'ALTER TABLE products ADD CONSTRAINT chk_price CHECK (price >= 0) NOT VALID;';
    const res = analyzeSql(sql, { rules: [checkConstraintMissingNotValidRule] });
    assert.strictEqual(res.blockersCount, 0);
    assert.strictEqual(res.findings.length, 0);
  });

  it('passes anonymous ADD CHECK ... NOT VALID', () => {
    const sql = 'ALTER TABLE products ADD CHECK (price >= 0) NOT VALID;';
    const res = analyzeSql(sql, { rules: [checkConstraintMissingNotValidRule] });
    assert.strictEqual(res.blockersCount, 0);
  });

  it('passes VALIDATE CONSTRAINT statement', () => {
    const sql = 'ALTER TABLE products VALIDATE CONSTRAINT chk_price;';
    const res = analyzeSql(sql, { rules: [checkConstraintMissingNotValidRule] });
    assert.strictEqual(res.blockersCount, 0);
  });

  it('detects multiple CHECK clauses where one lacks NOT VALID', () => {
    const sql = `ALTER TABLE items
      ADD CONSTRAINT chk_a CHECK (a > 0),
      ADD CONSTRAINT chk_b CHECK (b > 0) NOT VALID;`;
    const res = analyzeSql(sql, { rules: [checkConstraintMissingNotValidRule] });
    assert.strictEqual(res.blockersCount, 1);
    assert.ok(res.findings[0].message.includes('"chk_a"'));
  });

  it('passes when ignored with directive comment (new or legacy id)', () => {
    const sql1 = `-- ddlforge-ignore check-constraint-missing-not-valid\nALTER TABLE t ADD CONSTRAINT c CHECK (x > 0);`;
    assert.strictEqual(analyzeSql(sql1, { rules: [checkConstraintMissingNotValidRule] }).findings.length, 0);

    const sql2 = `-- ddlforge-ignore check-constraint-not-valid\nALTER TABLE t ADD CONSTRAINT c CHECK (x > 0);`;
    assert.strictEqual(analyzeSql(sql2, { rules: [checkConstraintMissingNotValidRule] }).findings.length, 0);
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* Rule 3: detach-partition-non-concurrent                                    */
/* ────────────────────────────────────────────────────────────────────────── */

describe('Rule: detach-partition-non-concurrent', () => {
  it('detects ALTER TABLE DETACH PARTITION lacking CONCURRENTLY as BLOCKER in PG16', () => {
    const sql = 'ALTER TABLE measurement DETACH PARTITION measurement_y2026m01;';
    const res = analyzeSql(sql, { rules: [detachPartitionNonConcurrentRule], pgVersion: 16 });
    assert.strictEqual(res.blockersCount, 1);
    const f = res.findings[0];
    assert.strictEqual(f.ruleId, 'detach-partition-non-concurrent');
    assert.strictEqual(f.severity, 'BLOCKER');
    assert.strictEqual(f.lockLevel, PostgresLockLevel.ACCESS_EXCLUSIVE);
    assert.ok(f.message.includes('"measurement_y2026m01"'));
    assert.ok(f.message.includes('"measurement"'));
    assert.ok(f.suggestion.includes('DETACH PARTITION measurement_y2026m01 CONCURRENTLY'));
  });

  it('detects DETACH PARTITION with IF EXISTS or ONLY modifiers', () => {
    const sql = 'ALTER TABLE IF EXISTS ONLY logs DETACH PARTITION IF EXISTS logs_2025;';
    const res = analyzeSql(sql, { rules: [detachPartitionNonConcurrentRule], pgVersion: 15 });
    assert.strictEqual(res.blockersCount, 1);
    assert.ok(res.findings[0].message.includes('"logs"'));
  });

  it('passes ALTER TABLE DETACH PARTITION CONCURRENTLY', () => {
    const sql = 'ALTER TABLE measurement DETACH PARTITION measurement_y2026m01 CONCURRENTLY;';
    const res = analyzeSql(sql, { rules: [detachPartitionNonConcurrentRule], pgVersion: 16 });
    assert.strictEqual(res.blockersCount, 0);
    assert.strictEqual(res.findings.length, 0);
  });

  it('passes ALTER TABLE DETACH PARTITION FINALIZE (recovering failed concurrent detach)', () => {
    const sql = 'ALTER TABLE measurement DETACH PARTITION measurement_y2026m01 FINALIZE;';
    const res = analyzeSql(sql, { rules: [detachPartitionNonConcurrentRule], pgVersion: 16 });
    assert.strictEqual(res.blockersCount, 0);
  });

  it('does not flag in PostgreSQL < 14 (CONCURRENTLY detach was added in PG 14)', () => {
    const sql = 'ALTER TABLE measurement DETACH PARTITION measurement_y2026m01;';
    const res = analyzeSql(sql, { rules: [detachPartitionNonConcurrentRule], pgVersion: 13 });
    assert.strictEqual(res.blockersCount, 0);
  });

  it('passes ATTACH PARTITION operations', () => {
    const sql = 'ALTER TABLE measurement ATTACH PARTITION measurement_y2026m02 FOR VALUES FROM (2026) TO (2027);';
    const res = analyzeSql(sql, { rules: [detachPartitionNonConcurrentRule], pgVersion: 16 });
    assert.strictEqual(res.blockersCount, 0);
  });

  it('passes when ignored with directive comment', () => {
    const sql = `-- ddlforge-ignore detach-partition-non-concurrent\nALTER TABLE measurement DETACH PARTITION measurement_2025;`;
    const res = analyzeSql(sql, { rules: [detachPartitionNonConcurrentRule], pgVersion: 16 });
    assert.strictEqual(res.findings.length, 0);
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* Rule 4: reindex-missing-concurrently                                       */
/* ────────────────────────────────────────────────────────────────────────── */

describe('Rule: reindex-missing-concurrently', () => {
  it('detects REINDEX TABLE lacking CONCURRENTLY as BLOCKER', () => {
    const sql = 'REINDEX TABLE users;';
    const res = analyzeSql(sql, { rules: [reindexMissingConcurrentlyRule] });
    assert.strictEqual(res.blockersCount, 1);
    const f = res.findings[0];
    assert.strictEqual(f.ruleId, 'reindex-missing-concurrently');
    assert.strictEqual(f.severity, 'BLOCKER');
    assert.strictEqual(f.lockLevel, PostgresLockLevel.ACCESS_EXCLUSIVE);
    assert.ok(f.message.includes('TABLE "users"'));
    assert.ok(f.suggestion.includes('REINDEX TABLE CONCURRENTLY users;'));
  });

  it('detects REINDEX INDEX lacking CONCURRENTLY as BLOCKER', () => {
    const sql = 'REINDEX INDEX idx_users_email;';
    const res = analyzeSql(sql, { rules: [reindexMissingConcurrentlyRule] });
    assert.strictEqual(res.blockersCount, 1);
    assert.ok(res.findings[0].message.includes('INDEX "idx_users_email"'));
  });

  it('detects REINDEX SCHEMA lacking CONCURRENTLY as BLOCKER', () => {
    const sql = 'REINDEX SCHEMA public;';
    const res = analyzeSql(sql, { rules: [reindexMissingConcurrentlyRule] });
    assert.strictEqual(res.blockersCount, 1);
    assert.ok(res.findings[0].message.includes('SCHEMA "public"'));
  });

  it('detects REINDEX (VERBOSE) lacking CONCURRENTLY as BLOCKER', () => {
    const sql = 'REINDEX (VERBOSE) TABLE orders;';
    const res = analyzeSql(sql, { rules: [reindexMissingConcurrentlyRule] });
    assert.strictEqual(res.blockersCount, 1);
    assert.ok(res.findings[0].message.includes('TABLE "orders"'));
  });

  it('passes REINDEX TABLE CONCURRENTLY', () => {
    const sql = 'REINDEX TABLE CONCURRENTLY users;';
    const res = analyzeSql(sql, { rules: [reindexMissingConcurrentlyRule] });
    assert.strictEqual(res.blockersCount, 0);
  });

  it('passes REINDEX INDEX CONCURRENTLY', () => {
    const sql = 'REINDEX INDEX CONCURRENTLY idx_users_email;';
    const res = analyzeSql(sql, { rules: [reindexMissingConcurrentlyRule] });
    assert.strictEqual(res.blockersCount, 0);
  });

  it('passes REINDEX (CONCURRENTLY) TABLE users', () => {
    const sql = 'REINDEX (CONCURRENTLY) TABLE users;';
    const res = analyzeSql(sql, { rules: [reindexMissingConcurrentlyRule] });
    assert.strictEqual(res.blockersCount, 0);
  });

  it('passes REINDEX (VERBOSE, CONCURRENTLY) TABLE users', () => {
    const sql = 'REINDEX (VERBOSE, CONCURRENTLY) TABLE users;';
    const res = analyzeSql(sql, { rules: [reindexMissingConcurrentlyRule] });
    assert.strictEqual(res.blockersCount, 0);
  });

  it('passes when ignored with directive comment', () => {
    const sql = `-- ddlforge-ignore reindex-missing-concurrently\nREINDEX TABLE users;`;
    const res = analyzeSql(sql, { rules: [reindexMissingConcurrentlyRule] });
    assert.strictEqual(res.findings.length, 0);
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* Rule 5: enum-add-value-in-transaction                                      */
/* ────────────────────────────────────────────────────────────────────────── */

describe('Rule: enum-add-value-in-transaction', () => {
  it('detects ALTER TYPE ... ADD VALUE inside BEGIN ... COMMIT block', () => {
    const sql = `
      BEGIN;
      ALTER TYPE user_role ADD VALUE 'admin';
      COMMIT;
    `;
    const res = analyzeSql(sql, { rules: [enumAddValueInTransactionRule] });
    assert.strictEqual(res.blockersCount, 1);
    const f = res.findings[0];
    assert.strictEqual(f.ruleId, 'enum-add-value-in-transaction');
    assert.strictEqual(f.severity, 'BLOCKER');
    assert.ok(f.message.includes('explicit transaction block'));
    assert.ok(f.message.includes("'admin'"));
  });

  it('detects ALTER TYPE ... ADD VALUE inside START TRANSACTION ... END block', () => {
    const sql = `
      START TRANSACTION;
      ALTER TYPE order_status ADD VALUE 'refunded';
      END;
    `;
    const res = analyzeSql(sql, { rules: [enumAddValueInTransactionRule] });
    assert.strictEqual(res.blockersCount, 1);
    assert.ok(res.findings[0].message.includes("'refunded'"));
  });

  it('detects ALTER TYPE ... ADD VALUE in Prisma migration without -- prisma:no-transaction', () => {
    const sql = `ALTER TYPE user_status ADD VALUE 'archived';`;
    const res = analyzeSql(sql, {
      rules: [enumAddValueInTransactionRule],
      filePath: 'prisma/migrations/20260918_enum/migration.sql',
    });
    assert.strictEqual(res.blockersCount, 1);
    assert.ok(res.findings[0].message.includes('-- prisma:no-transaction'));
  });

  it('passes ALTER TYPE ... ADD VALUE in Prisma migration WITH -- prisma:no-transaction', () => {
    const sql = `
      -- prisma:no-transaction
      ALTER TYPE user_status ADD VALUE 'archived';
    `;
    const res = analyzeSql(sql, {
      rules: [enumAddValueInTransactionRule],
      filePath: 'prisma/migrations/20260918_enum/migration.sql',
    });
    assert.strictEqual(res.blockersCount, 0);
  });

  it('detects new enum value referenced immediately in subsequent statement within the same file', () => {
    const sql = `
      ALTER TYPE user_role ADD VALUE 'moderator';
      INSERT INTO users (name, role) VALUES ('alice', 'moderator');
    `;
    const res = analyzeSql(sql, { rules: [enumAddValueInTransactionRule] });
    assert.strictEqual(res.blockersCount, 1);
    const f = res.findings[0];
    assert.ok(f.message.includes("referenced in subsequent statement"));
    assert.ok(f.detail.includes("unsafe use of new value"));
  });

  it('passes ALTER TYPE ... ADD VALUE when run standalone and not referenced in same file', () => {
    const sql = `ALTER TYPE user_role ADD VALUE 'auditor';`;
    const res = analyzeSql(sql, { rules: [enumAddValueInTransactionRule] });
    assert.strictEqual(res.blockersCount, 0);
    assert.strictEqual(res.findings.length, 0);
  });

  it('supports IF NOT EXISTS and AFTER/BEFORE clauses in ALTER TYPE ADD VALUE', () => {
    const sql = `
      BEGIN;
      ALTER TYPE status ADD VALUE IF NOT EXISTS 'pending_review' AFTER 'active';
      COMMIT;
    `;
    const res = analyzeSql(sql, { rules: [enumAddValueInTransactionRule] });
    assert.strictEqual(res.blockersCount, 1);
    assert.ok(res.findings[0].message.includes("'pending_review'"));
  });

  it('passes when ignored with directive comment', () => {
    const sql = `
      BEGIN;
      -- ddlforge-ignore enum-add-value-in-transaction
      ALTER TYPE status ADD VALUE 'new_val';
      COMMIT;
    `;
    const res = analyzeSql(sql, { rules: [enumAddValueInTransactionRule] });
    assert.strictEqual(res.findings.length, 0);
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* Rule 6: maintenance-command-detected                                       */
/* ────────────────────────────────────────────────────────────────────────── */

describe('Rule: maintenance-command-detected', () => {
  it('detects VACUUM FULL as BLOCKER', () => {
    const sql = 'VACUUM FULL users;';
    const res = analyzeSql(sql, { rules: [maintenanceCommandDetectedRule] });
    assert.strictEqual(res.blockersCount, 1);
    const f = res.findings[0];
    assert.strictEqual(f.ruleId, 'maintenance-command-detected');
    assert.strictEqual(f.severity, 'BLOCKER');
    assert.strictEqual(f.lockLevel, PostgresLockLevel.ACCESS_EXCLUSIVE);
    assert.ok(f.message.includes('VACUUM FULL'));
    assert.ok(f.detail.includes('ACCESS EXCLUSIVE'));
  });

  it('detects bare VACUUM as BLOCKER in migration', () => {
    const sql = 'VACUUM ANALYZE users;';
    const res = analyzeSql(sql, { rules: [maintenanceCommandDetectedRule] });
    assert.strictEqual(res.blockersCount, 1);
    assert.ok(res.findings[0].message.includes('VACUUM'));
  });

  it('detects CLUSTER as BLOCKER', () => {
    const sql = 'CLUSTER users USING users_idx;';
    const res = analyzeSql(sql, { rules: [maintenanceCommandDetectedRule] });
    assert.strictEqual(res.blockersCount, 1);
    const f = res.findings[0];
    assert.strictEqual(f.ruleId, 'maintenance-command-detected');
    assert.ok(f.message.includes('CLUSTER'));
  });

  it('detects TRUNCATE TABLE as BLOCKER', () => {
    const sql = 'TRUNCATE TABLE sessions;';
    const res = analyzeSql(sql, { rules: [maintenanceCommandDetectedRule] });
    assert.strictEqual(res.blockersCount, 1);
    const f = res.findings[0];
    assert.strictEqual(f.ruleId, 'maintenance-command-detected');
    assert.strictEqual(f.severity, 'BLOCKER');
    assert.ok(f.message.includes('TRUNCATE'));
    assert.ok(f.message.includes('"sessions"'));
  });

  it('detects TRUNCATE with multiple tables', () => {
    const sql = 'TRUNCATE sessions, cache_entries;';
    const res = analyzeSql(sql, { rules: [maintenanceCommandDetectedRule] });
    assert.strictEqual(res.blockersCount, 1);
  });

  it('does not flag SELECT or comments mentioning maintenance terms', () => {
    const sql = `
      -- Running vacuum or truncate safely
      SELECT id FROM maintenance_logs WHERE action = 'vacuum_full';
    `;
    const res = analyzeSql(sql, { rules: [maintenanceCommandDetectedRule] });
    assert.strictEqual(res.blockersCount, 0);
  });

  it('passes when ignored with directive comment', () => {
    const sql = `-- ddlforge-ignore maintenance-command-detected\nTRUNCATE TABLE logs;`;
    assert.strictEqual(analyzeSql(sql, { rules: [maintenanceCommandDetectedRule] }).findings.length, 0);
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* Adversarial & Multi-Rule Integration Tests                                 */
/* ────────────────────────────────────────────────────────────────────────── */

describe('Adversarial & Multi-Rule Integration', () => {
  it('detects all 6 new rule violations in a single adversarial migration', () => {
    const multiSql = `
      -- 1. Detach partition without CONCURRENTLY
      ALTER TABLE measurements DETACH PARTITION measurements_2025;

      -- 2. Maintenance VACUUM FULL
      VACUUM FULL accounts;

      -- 3. Maintenance TRUNCATE
      TRUNCATE TABLE temp_sessions;

      -- 4. REINDEX without CONCURRENTLY
      REINDEX TABLE audit_logs;

      -- 5. Primary key without USING INDEX
      ALTER TABLE profiles ADD PRIMARY KEY (user_id);

      -- 6. Check constraint without NOT VALID
      ALTER TABLE profiles ADD CONSTRAINT chk_age CHECK (age >= 18);

      -- 7. Enum added in transaction block
      BEGIN;
      ALTER TYPE user_status ADD VALUE 'suspended';
      COMMIT;
    `;

    const res = analyzeSql(multiSql);
    assert.ok(res.blockersCount >= 7, `Expected at least 7 blockers, got ${res.blockersCount}`);

    const ruleIdsFound = new Set(res.findings.map(f => f.ruleId));
    assert.ok(ruleIdsFound.has('detach-partition-non-concurrent'));
    assert.ok(ruleIdsFound.has('maintenance-command-detected'));
    assert.ok(ruleIdsFound.has('reindex-missing-concurrently'));
    assert.ok(ruleIdsFound.has('add-primary-key-missing-using-index'));
    assert.ok(ruleIdsFound.has('check-constraint-missing-not-valid'));
    assert.ok(ruleIdsFound.has('enum-add-value-in-transaction'));
  });

  it('produces 0 blockers for an adversarial safe migration utilizing all safe patterns', () => {
    const safeSql = `
      -- 1. Detach partition with CONCURRENTLY (PG14+)
      ALTER TABLE measurements DETACH PARTITION measurements_2025 CONCURRENTLY;

      -- 2. REINDEX with CONCURRENTLY
      REINDEX TABLE CONCURRENTLY audit_logs;

      -- 3. Primary key with USING INDEX
      CREATE UNIQUE INDEX CONCURRENTLY idx_profiles_user_id ON profiles (user_id);
      ALTER TABLE profiles ADD CONSTRAINT pk_profiles PRIMARY KEY USING INDEX idx_profiles_user_id;

      -- 4. Check constraint with NOT VALID + isolated validate
      ALTER TABLE profiles ADD CONSTRAINT chk_age CHECK (age >= 18) NOT VALID;
      ALTER TABLE profiles VALIDATE CONSTRAINT chk_age;

      -- 5. Enum added standalone outside transaction
      ALTER TYPE user_status ADD VALUE 'suspended';

      -- 6. Foreign key with NOT VALID + isolated validate
      ALTER TABLE profiles ADD CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id) NOT VALID;
      ALTER TABLE profiles VALIDATE CONSTRAINT fk_user;
    `;

    const res = analyzeSql(safeSql, { pgVersion: 16 });
    assert.strictEqual(res.blockersCount, 0, `Unexpected blockers in safe migration: ${JSON.stringify(res.findings)}`);
  });

  it('does not false positive on keywords inside comments or dollar-quoted bodies', () => {
    const dollarSql = `
      CREATE OR REPLACE FUNCTION purge_archive() RETURNS void AS $$
      BEGIN
        -- TRUNCATE TABLE is mentioned in a comment
        -- VACUUM FULL is mentioned in a comment
        -- ALTER TABLE t DETACH PARTITION p is mentioned in a comment
        DELETE FROM archive WHERE created_at < NOW() - INTERVAL '30 days';
      END;
      $$ LANGUAGE plpgsql;
    `;

    const res = analyzeSql(dollarSql);
    assert.strictEqual(res.blockersCount, 0);
  });

  it('handles lowercase, tabs, and schema-qualified tables', () => {
    const lowerSql = 'alter table "public"."tenants" add constraint "pk_tenants" primary key ("tenant_id");';
    const res = analyzeSql(lowerSql, { rules: [addPrimaryKeyMissingUsingIndexRule] });
    assert.strictEqual(res.blockersCount, 1);
    assert.strictEqual(res.findings[0].ruleId, 'add-primary-key-missing-using-index');
    assert.ok(res.findings[0].message.includes('"pk_tenants"'));
  });
});


/**
 * ddlforge - Unit tests for Zero-Downtime Remediation Engine
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import {
  buildNotNullColumnRemediation,
  buildUnvalidatedForeignKeyRemediation,
  buildPrimaryKeyUsingIndexRemediation,
  buildColumnTypeRewriteRemediation,
} from '../src/remediations/index.js';
import { analyzeSql, formatTerminal, formatMarkdown } from '../src/index.js';
import {
  addColumnNotNullRule,
  foreignKeyNotValidRule,
  alterColumnTypeRewriteRule,
  addPrimaryKeyMissingUsingIndexRule,
} from '../src/rules/index.js';

describe('Remediation: buildNotNullColumnRemediation()', () => {
  it('interpolates table, column, and defaults properly', () => {
    const recipe = buildNotNullColumnRemediation({
      table: 'users',
      column: 'email',
      type: 'VARCHAR(255)',
      defaultValue: "'unknown@example.com'",
    });

    assert.strictEqual(recipe.ruleId, 'not-null-column-addition');
    assert.strictEqual(recipe.phases.length, 3);

    // Phase 1 checks
    const p1 = recipe.phases[0];
    assert.strictEqual(p1.phase, 1);
    assert.strictEqual(p1.transactional, true);
    assert.ok(p1.sql.includes("SET LOCAL lock_timeout = '2s';"));
    assert.ok(p1.sql.includes('ALTER TABLE users ADD COLUMN email VARCHAR(255);'));
    assert.ok(p1.sql.includes('ALTER TABLE users ADD CONSTRAINT chk_users_email_not_null CHECK (email IS NOT NULL) NOT VALID;'));

    // Phase 2 checks
    const p2 = recipe.phases[1];
    assert.strictEqual(p2.phase, 2);
    assert.strictEqual(p2.transactional, false);
    assert.ok(p2.sql.includes('UPDATE users'));
    assert.ok(p2.sql.includes("SET email = 'unknown@example.com'"));
    assert.ok(p2.sql.includes('LIMIT 5000'));
    assert.ok(p2.sql.includes('PERFORM pg_sleep(0.1);'));

    // Phase 3 checks
    const p3 = recipe.phases[2];
    assert.strictEqual(p3.phase, 3);
    assert.ok(p3.sql.includes('ALTER TABLE users VALIDATE CONSTRAINT chk_users_email_not_null;'));
    assert.ok(p3.sql.includes("SET LOCAL lock_timeout = '2s';"));
    assert.ok(p3.sql.includes('ALTER TABLE users ALTER COLUMN email SET NOT NULL;'));
    assert.ok(p3.sql.includes('ALTER TABLE users DROP CONSTRAINT chk_users_email_not_null;'));
  });

  it('handles quotes and cleans identifiers', () => {
    const recipe = buildNotNullColumnRemediation({
      table: '"orders"',
      column: '"status"',
    });

    assert.ok(recipe.phases[0].sql.includes('ALTER TABLE orders ADD COLUMN status TEXT;'));
    assert.ok(recipe.phases[0].sql.includes('chk_orders_status_not_null'));
    assert.ok(!recipe.phases[0].sql.includes('"orders"'));
  });

  it('uses default fallback values when type and defaultValue are omitted', () => {
    const recipe = buildNotNullColumnRemediation({
      table: 'accounts',
      column: 'balance',
    });

    assert.ok(recipe.phases[0].sql.includes('ADD COLUMN balance TEXT;'));
    assert.ok(recipe.phases[1].sql.includes("SET balance = 'default_value'"));
  });
});

describe('Remediation: buildUnvalidatedForeignKeyRemediation()', () => {
  it('generates two-phase foreign key remediation', () => {
    const recipe = buildUnvalidatedForeignKeyRemediation({
      table: 'orders',
      constraintName: 'fk_orders_customer_id',
      column: 'customer_id',
      foreignTable: 'customers',
      foreignColumn: 'id',
    });

    assert.strictEqual(recipe.ruleId, 'unvalidated-foreign-key');
    assert.strictEqual(recipe.phases.length, 2);

    // Phase 1
    const p1 = recipe.phases[0];
    assert.strictEqual(p1.transactional, true);
    assert.ok(p1.sql.includes("SET LOCAL lock_timeout = '2s';"));
    assert.ok(
      p1.sql.includes(
        'ALTER TABLE orders ADD CONSTRAINT fk_orders_customer_id FOREIGN KEY (customer_id) REFERENCES customers (id) NOT VALID;'
      )
    );

    // Phase 2
    const p2 = recipe.phases[1];
    assert.strictEqual(p2.transactional, false);
    assert.ok(p2.sql.includes('ALTER TABLE orders VALIDATE CONSTRAINT fk_orders_customer_id;'));
  });

  it('synthesizes constraintName when not provided', () => {
    const recipe = buildUnvalidatedForeignKeyRemediation({
      table: 'items',
      column: 'order_id',
      foreignTable: 'orders',
      foreignColumn: 'id',
    });

    assert.ok(recipe.phases[0].sql.includes('fk_items_order_id'));
    assert.ok(recipe.phases[1].sql.includes('VALIDATE CONSTRAINT fk_items_order_id;'));
  });
});

describe('Remediation: buildPrimaryKeyUsingIndexRemediation()', () => {
  it('generates two-phase primary key remediation with array columns', () => {
    const recipe = buildPrimaryKeyUsingIndexRemediation({
      table: 'order_items',
      constraintName: 'pk_order_items',
      columns: ['order_id', 'item_id'],
      indexName: 'idx_order_items_pk',
    });

    assert.strictEqual(recipe.ruleId, 'primary-key-missing-using-index');
    assert.strictEqual(recipe.phases.length, 2);

    // Phase 1
    const p1 = recipe.phases[0];
    assert.strictEqual(p1.transactional, false);
    assert.ok(p1.sql.includes('CREATE UNIQUE INDEX CONCURRENTLY idx_order_items_pk ON order_items (order_id, item_id);'));

    // Phase 2
    const p2 = recipe.phases[1];
    assert.strictEqual(p2.transactional, true);
    assert.ok(p2.sql.includes("SET LOCAL lock_timeout = '2s';"));
    assert.ok(p2.sql.includes('ALTER TABLE order_items ADD CONSTRAINT pk_order_items PRIMARY KEY USING INDEX idx_order_items_pk;'));
  });

  it('generates primary key remediation with string columns and auto-named index', () => {
    const recipe = buildPrimaryKeyUsingIndexRemediation({
      table: 'users',
      columns: 'id',
    });

    assert.ok(recipe.phases[0].sql.includes('CREATE UNIQUE INDEX CONCURRENTLY idx_users_id_pk ON users (id);'));
    assert.ok(recipe.phases[1].sql.includes('ADD CONSTRAINT pk_users PRIMARY KEY USING INDEX idx_users_id_pk;'));
  });
});

describe('Remediation: buildColumnTypeRewriteRemediation()', () => {
  it('generates 3-phase shadow column and dual-write trigger rewrite', () => {
    const recipe = buildColumnTypeRewriteRemediation({
      table: 'events',
      column: 'payload',
      newType: 'JSONB',
      shadowColumn: 'payload_jsonb',
      triggerName: 'trg_sync_events_payload',
      functionName: 'sync_events_payload',
    });

    assert.strictEqual(recipe.ruleId, 'column-type-rewrite');
    assert.strictEqual(recipe.phases.length, 3);

    // Phase 1
    const p1 = recipe.phases[0];
    assert.strictEqual(p1.transactional, true);
    assert.ok(p1.sql.includes("SET LOCAL lock_timeout = '2s';"));
    assert.ok(p1.sql.includes('ALTER TABLE events ADD COLUMN payload_jsonb JSONB;'));
    assert.ok(p1.sql.includes('CREATE OR REPLACE FUNCTION sync_events_payload()'));
    assert.ok(p1.sql.includes('NEW.payload_jsonb := NEW.payload::JSONB;'));
    assert.ok(p1.sql.includes('CREATE TRIGGER trg_sync_events_payload'));

    // Phase 2
    const p2 = recipe.phases[1];
    assert.strictEqual(p2.transactional, false);
    assert.ok(p2.sql.includes('UPDATE events'));
    assert.ok(p2.sql.includes('SET payload_jsonb = payload::JSONB'));
    assert.ok(p2.sql.includes('LIMIT 5000'));
    assert.ok(p2.sql.includes('PERFORM pg_sleep(0.1);'));

    // Phase 3
    const p3 = recipe.phases[2];
    assert.strictEqual(p3.transactional, true);
    assert.ok(p3.sql.includes("SET LOCAL lock_timeout = '2s';"));
    assert.ok(p3.sql.includes('DROP TRIGGER trg_sync_events_payload ON events;'));
    assert.ok(p3.sql.includes('DROP FUNCTION sync_events_payload();'));
    assert.ok(p3.sql.includes('ALTER TABLE events RENAME COLUMN payload TO payload_old;'));
    assert.ok(p3.sql.includes('ALTER TABLE events RENAME COLUMN payload_jsonb TO payload;'));
  });

  it('uses default names when trigger and function names are omitted', () => {
    const recipe = buildColumnTypeRewriteRemediation({
      table: 'users',
      column: 'age',
      newType: 'BIGINT',
    });

    assert.ok(recipe.phases[0].sql.includes('ALTER TABLE users ADD COLUMN age_new BIGINT;'));
    assert.ok(recipe.phases[0].sql.includes('sync_users_age_new'));
    assert.ok(recipe.phases[0].sql.includes('trg_sync_users_age_new'));
  });
});

describe('Remediation: Integration with Analyzer and Reporters', () => {
  it('populates remediation in addColumnNotNull finding', () => {
    const sql = 'ALTER TABLE users ADD COLUMN bio TEXT NOT NULL;';
    const res = analyzeSql(sql, { rules: [addColumnNotNullRule] });
    assert.strictEqual(res.findings.length, 1);
    const f = res.findings[0];
    assert.ok(f.remediation !== undefined);
    assert.ok(f.remediation.includes("SET LOCAL lock_timeout = '2s';"));
    assert.ok(f.remediation.includes('chk_users_bio_not_null'));
    assert.ok(f.remediation.includes('LIMIT 5000'));
  });

  it('populates remediation in foreignKeyNotValid finding', () => {
    const sql = 'ALTER TABLE orders ADD CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id);';
    const res = analyzeSql(sql, { rules: [foreignKeyNotValidRule] });
    assert.strictEqual(res.findings.length, 1);
    const f = res.findings[0];
    assert.ok(f.remediation !== undefined);
    assert.ok(f.remediation.includes("SET LOCAL lock_timeout = '2s';"));
    assert.ok(f.remediation.includes('VALIDATE CONSTRAINT fk_user;'));
  });

  it('populates remediation in alterColumnTypeRewrite finding', () => {
    const sql = 'ALTER TABLE users ALTER COLUMN age TYPE bigint;';
    const res = analyzeSql(sql, { rules: [alterColumnTypeRewriteRule] });
    assert.strictEqual(res.findings.length, 1);
    const f = res.findings[0];
    assert.ok(f.remediation !== undefined);
    assert.ok(f.remediation.includes("SET LOCAL lock_timeout = '2s';"));
    assert.ok(f.remediation.includes('sync_users_age_new'));
  });

  it('populates remediation in addPrimaryKeyMissingUsingIndex finding', () => {
    const sql = 'ALTER TABLE users ADD CONSTRAINT pk_users PRIMARY KEY (id);';
    const res = analyzeSql(sql, { rules: [addPrimaryKeyMissingUsingIndexRule] });
    assert.strictEqual(res.findings.length, 1);
    const f = res.findings[0];
    assert.ok(f.remediation !== undefined);
    assert.ok(f.remediation.includes('CREATE UNIQUE INDEX CONCURRENTLY'));
    assert.ok(f.remediation.includes('PRIMARY KEY USING INDEX'));
  });

  it('terminal reporter formats the remediation recipe block cleanly', () => {
    const sql = 'ALTER TABLE users ADD COLUMN score INT NOT NULL;';
    const res = analyzeSql(sql, { rules: [addColumnNotNullRule], filePath: 'test.sql' });
    const output = formatTerminal([res], { color: false });
    assert.ok(output.includes('Zero-Downtime Remediation Recipe:'));
    assert.ok(output.includes("SET LOCAL lock_timeout = '2s';"));
  });

  it('markdown reporter embeds the remediation recipe block in details', () => {
    const sql = 'ALTER TABLE users ADD COLUMN score INT NOT NULL;';
    const res = analyzeSql(sql, { rules: [addColumnNotNullRule], filePath: 'test.sql' });
    const md = formatMarkdown([res]);
    assert.ok(md.includes('**Zero-Downtime Remediation Recipe:**'));
    assert.ok(md.includes("SET LOCAL lock_timeout = '2s';"));
  });
});

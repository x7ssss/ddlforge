/**
 * ddlforge — test/masking/triggers.test.ts
 *
 * Unit tests for in-flight trigger data masking generator:
 *   - Helper functions: HMAC-SHA256 tokenization, Feistel integer cipher, email & UUID masking
 *   - Trigger definition: BEFORE INSERT OR UPDATE, in-memory mutation, recursion termination
 *   - Security hardening: SECURITY DEFINER, search_path = pg_catalog, pg_temp
 *   - Column parsing & teardown SQL
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateMaskingTrigger,
  generateMaskingHelpers,
  parseColumnMaskConfigs,
} from '../../src/masking/triggers.js';

describe('parseColumnMaskConfigs()', () => {
  it('parses "column:type" format into structured configs', () => {
    const configs = parseColumnMaskConfigs(['email:email', 'user_id:integer', 'tenant_id:uuid', 'ssn:text']);

    assert.strictEqual(configs.length, 4);
    assert.strictEqual(configs[0].sourceColumn, 'email');
    assert.strictEqual(configs[0].targetColumn, 'email_masked');
    assert.strictEqual(configs[0].maskType, 'email');

    assert.strictEqual(configs[1].sourceColumn, 'user_id');
    assert.strictEqual(configs[1].targetColumn, 'user_id_masked');
    assert.strictEqual(configs[1].maskType, 'integer');

    assert.strictEqual(configs[2].sourceColumn, 'tenant_id');
    assert.strictEqual(configs[2].maskType, 'uuid');

    assert.strictEqual(configs[3].sourceColumn, 'ssn');
    assert.strictEqual(configs[3].maskType, 'text');
  });

  it('supports explicit source:target:type 3-part format', () => {
    const configs = parseColumnMaskConfigs(['phone:phone_sanitized:text']);
    assert.strictEqual(configs[0].sourceColumn, 'phone');
    assert.strictEqual(configs[0].targetColumn, 'phone_sanitized');
    assert.strictEqual(configs[0].maskType, 'text');
  });

  it('defaults single column name to text masking with _masked suffix', () => {
    const configs = parseColumnMaskConfigs(['notes']);
    assert.strictEqual(configs[0].sourceColumn, 'notes');
    assert.strictEqual(configs[0].targetColumn, 'notes_masked');
    assert.strictEqual(configs[0].maskType, 'text');
  });
});

describe('generateMaskingHelpers()', () => {
  it('generates pgcrypto extension and cryptographic functions', () => {
    const sql = generateMaskingHelpers('app.masking_salt');

    assert.ok(sql.includes('CREATE EXTENSION IF NOT EXISTS pgcrypto;'));
    assert.ok(sql.includes('CREATE OR REPLACE FUNCTION _ddlforge_hmac_token'));
    assert.ok(sql.includes('CREATE OR REPLACE FUNCTION feistel_encrypt_integer'));
    assert.ok(sql.includes('CREATE OR REPLACE FUNCTION _ddlforge_mask_email'));
    assert.ok(sql.includes('CREATE OR REPLACE FUNCTION _ddlforge_mask_uuid'));
  });

  it('incorporates dynamic GUC salt retrieval in HMAC function', () => {
    const sql = generateMaskingHelpers('my_custom.salt');
    assert.ok(sql.includes("current_setting('my_custom.salt', true)"));
  });

  it('implements 16-round Feistel integer cipher with bitwise arithmetic', () => {
    const sql = generateMaskingHelpers();
    assert.ok(sql.includes('FOR v_round IN 1..16 LOOP'));
    assert.ok(sql.includes('v_mask BIGINT := 4294967295;'));
    assert.ok(sql.includes('((v_r << 32) | v_l)'));
    assert.ok(sql.includes('IMMUTABLE PARALLEL SAFE'));
  });

  it('enforces SECURITY DEFINER and strict search_path on helper functions', () => {
    const sql = generateMaskingHelpers();
    const count = (sql.match(/SECURITY DEFINER\s+SET search_path = pg_catalog, pg_temp/g) || []).length;
    assert.ok(count >= 4, `Expected at least 4 security definer declarations, found ${count}`);
  });
});

describe('generateMaskingTrigger()', () => {
  it('generates trigger function and trigger for specified table and columns', () => {
    const result = generateMaskingTrigger({
      table: 'users',
      columns: ['email:email', 'user_id:integer'],
    });

    assert.strictEqual(result.triggerName, 'trg_mask_users');
    assert.strictEqual(result.functionName, 'tf_mask_users');

    // Trigger definition check
    assert.ok(result.triggerSql.includes('CREATE OR REPLACE TRIGGER "trg_mask_users"'));
    assert.ok(result.triggerSql.includes('BEFORE INSERT OR UPDATE ON "public"."users"'));
    assert.ok(result.triggerSql.includes('FOR EACH ROW'));
    assert.ok(result.triggerSql.includes('WHEN (pg_trigger_depth() < 2)'));
    assert.ok(result.triggerSql.includes('EXECUTE FUNCTION "public"."tf_mask_users"()'));

    // Trigger function mutations
    assert.ok(result.fullSql.includes('NEW."email_masked" := _ddlforge_mask_email(NEW."email", \'email\');'));
    assert.ok(result.fullSql.includes('NEW."user_id_masked" := feistel_encrypt_integer(NEW."user_id");'));
    assert.ok(result.fullSql.includes('NEW."email" IS DISTINCT FROM OLD."email"'));
    assert.ok(result.fullSql.includes('NEW."user_id" IS DISTINCT FROM OLD."user_id"'));
  });

  it('generates teardown SQL dropping both trigger and function', () => {
    const result = generateMaskingTrigger({
      table: 'accounts',
      columns: ['uuid:uuid'],
    });

    assert.ok(result.teardownSql.includes('DROP TRIGGER IF EXISTS "trg_mask_accounts" ON "public"."accounts";'));
    assert.ok(result.teardownSql.includes('DROP FUNCTION IF EXISTS "public"."tf_mask_accounts"();'));
  });

  it('supports custom expressions and custom schema', () => {
    const result = generateMaskingTrigger({
      table: 'orders',
      schema: 'sales',
      columns: [
        {
          sourceColumn: 'credit_card',
          targetColumn: 'cc_token',
          maskType: 'custom',
          customExpression: "sha256(NEW.credit_card::bytea)::text",
        },
      ],
    });

    assert.ok(result.fullSql.includes('ON "sales"."orders"'));
    assert.ok(result.fullSql.includes('NEW."cc_token" := sha256(NEW.credit_card::bytea)::text;'));
  });

  it('throws error when no columns provided', () => {
    assert.throws(() => {
      generateMaskingTrigger({
        table: 'empty_table',
        columns: [],
      });
    }, /At least one column must be specified/);
  });
});

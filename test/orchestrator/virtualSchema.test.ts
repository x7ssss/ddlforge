/**
 * ddlforge - Virtual Schema & View-Based Expand Engine Tests
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  normalizeSchemaName,
  parseTablesFromSql,
  generateTableVirtualView,
  generateVirtualSchema,
} from '../../src/orchestrator/virtualSchema.js';

describe('VirtualSchema: normalizeSchemaName', () => {
  it('normalizes version tags into schema names', () => {
    assert.strictEqual(normalizeSchemaName('v1'), 'public_v1');
    assert.strictEqual(normalizeSchemaName('v2'), 'public_v2');
    assert.strictEqual(normalizeSchemaName('V3'), 'public_v3');
    assert.strictEqual(normalizeSchemaName('public_v2'), 'public_v2');
    assert.strictEqual(normalizeSchemaName('v2', 'app'), 'app_v2');
  });
});

describe('VirtualSchema: parseTablesFromSql', () => {
  it('extracts table and columns from CREATE TABLE', () => {
    const sql = `CREATE TABLE users (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL,
      bio VARCHAR(255)
    );`;

    const tables = parseTablesFromSql(sql);
    assert.strictEqual(tables.length, 1);
    assert.strictEqual(tables[0].tableName, 'users');
    assert.strictEqual(tables[0].primaryKey, 'id');
    assert.deepStrictEqual(tables[0].columns, ['id', 'email', 'bio']);
  });

  it('extracts table-level composite PRIMARY KEY', () => {
    const sql = `CREATE TABLE order_items (
      order_id INT,
      item_id INT,
      quantity INT,
      PRIMARY KEY (order_id, item_id)
    );`;

    const tables = parseTablesFromSql(sql);
    assert.strictEqual(tables.length, 1);
    assert.strictEqual(tables[0].tableName, 'order_items');
    assert.strictEqual(tables[0].primaryKey, 'order_id');
    assert.ok(tables[0].columns.includes('order_id'));
    assert.ok(tables[0].columns.includes('item_id'));
    assert.ok(tables[0].columns.includes('quantity'));
  });

  it('extracts columns from ALTER TABLE ADD COLUMN', () => {
    const sql = `ALTER TABLE accounts ADD COLUMN balance NUMERIC;`;
    const tables = parseTablesFromSql(sql);
    assert.strictEqual(tables.length, 1);
    assert.strictEqual(tables[0].tableName, 'accounts');
    assert.ok(tables[0].columns.includes('balance'));
  });
});

describe('VirtualSchema: generateTableVirtualView & INSTEAD OF Triggers', () => {
  it('generates view and explicit INSTEAD OF triggers capturing RETURNING clause and reconstructing NEW', () => {
    const viewDef = generateTableVirtualView(
      {
        tableName: 'users',
        primaryKey: 'id',
        columns: ['id', 'email', 'name'],
      },
      'public_v2',
      'public'
    );

    // View definition
    assert.ok(viewDef.viewSql.includes('CREATE OR REPLACE VIEW "public_v2"."users" AS'));
    assert.ok(viewDef.viewSql.includes('FROM "public"."users"'));

    // INSTEAD OF INSERT trigger
    assert.ok(viewDef.insertTriggerSql.includes('CREATE OR REPLACE FUNCTION "public_v2"."tf_users_insert"()'));
    assert.ok(viewDef.insertTriggerSql.includes('RETURNING * INTO v_row;'));
    assert.ok(viewDef.insertTriggerSql.includes('NEW."id" := v_row."id";'));
    assert.ok(viewDef.insertTriggerSql.includes('NEW."email" := v_row."email";'));
    assert.ok(viewDef.insertTriggerSql.includes('NEW."name" := v_row."name";'));
    assert.ok(viewDef.insertTriggerSql.includes('INSTEAD OF INSERT ON "public_v2"."users"'));

    // INSTEAD OF UPDATE trigger
    assert.ok(viewDef.updateTriggerSql.includes('CREATE OR REPLACE FUNCTION "public_v2"."tf_users_update"()'));
    assert.ok(viewDef.updateTriggerSql.includes('WHERE "id" = OLD."id"'));
    assert.ok(viewDef.updateTriggerSql.includes('RETURNING * INTO v_row;'));
    assert.ok(viewDef.updateTriggerSql.includes('INSTEAD OF UPDATE ON "public_v2"."users"'));

    // INSTEAD OF DELETE trigger
    assert.ok(viewDef.deleteTriggerSql.includes('CREATE OR REPLACE FUNCTION "public_v2"."tf_users_delete"()'));
    assert.ok(viewDef.deleteTriggerSql.includes('DELETE FROM "public"."users"'));
    assert.ok(viewDef.deleteTriggerSql.includes('INSTEAD OF DELETE ON "public_v2"."users"'));
  });

  it('supports column renaming mappings between view and physical table', () => {
    const viewDef = generateTableVirtualView(
      {
        tableName: 'users',
        primaryKey: 'id',
        columns: [
          'id',
          { viewColumn: 'full_name', physicalColumn: 'name' },
        ],
      },
      'public_v2',
      'public'
    );

    assert.ok(viewDef.viewSql.includes('"name" AS "full_name"'));
    assert.ok(viewDef.insertTriggerSql.includes('NEW."full_name" := v_row."name";'));
  });
});

describe('VirtualSchema: generateVirtualSchema', () => {
  it('generates full schema with schema creation, views, triggers, and routing search_path', () => {
    const result = generateVirtualSchema({
      version: 'v2',
      tables: [
        {
          tableName: 'products',
          primaryKey: 'id',
          columns: ['id', 'sku', 'price'],
        },
      ],
    });

    assert.strictEqual(result.schemaName, 'public_v2');
    assert.ok(result.routingSql.includes('SET search_path = "public_v2", "public";'));
    assert.ok(result.fullSql.includes('CREATE SCHEMA IF NOT EXISTS "public_v2";'));
    assert.ok(result.fullSql.includes('CREATE OR REPLACE VIEW "public_v2"."products"'));
    assert.ok(result.fullSql.includes('SET search_path = "public_v2", "public";'));
  });

  it('parses tables directly from migration SQL file', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddlforge-vs-'));
    const migrationFile = path.join(tmpDir, 'migration.sql');

    try {
      const sql = `CREATE TABLE customers (id INT PRIMARY KEY, name TEXT);`;
      fs.writeFileSync(migrationFile, sql, 'utf-8');

      const result = generateVirtualSchema({
        version: 'v1',
        filePath: migrationFile,
      });

      assert.strictEqual(result.schemaName, 'public_v1');
      assert.strictEqual(result.views.length, 1);
      assert.strictEqual(result.views[0].tableName, 'customers');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

/**
 * ddlforge — test/diff/comparator.test.ts
 *
 * Unit tests for AST Schema Graph builder and comparator:
 *   - Extracting tables, columns, indexes, constraints, partitions, enums from SQL
 *   - Schema drift comparison: missing, extra, changed, unsafe classifications
 *   - Locking hazards: NOT NULL without DEFAULT, missing NOT VALID, missing CONCURRENTLY
 *   - Terminal and JSON formatting
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSchemaGraphFromSql,
  catalogToSchemaGraph,
  compareSchemas,
  formatDiffTerminal,
  formatDiffJson,
  normalizeType,
  createEmptySchemaGraph,
} from '../../src/diff/comparator.js';
import type { CatalogSchema } from '../../src/diff/catalog.js';

describe('normalizeType()', () => {
  it('normalizes integer variants to "integer"', () => {
    assert.strictEqual(normalizeType('int'), 'integer');
    assert.strictEqual(normalizeType('INT4'), 'integer');
    assert.strictEqual(normalizeType('integer'), 'integer');
  });

  it('normalizes varchar with length', () => {
    assert.strictEqual(normalizeType('character varying(255)'), 'varchar(255)');
    assert.strictEqual(normalizeType('VARCHAR(50)'), 'varchar(50)');
    assert.strictEqual(normalizeType('character varying'), 'varchar');
  });

  it('normalizes timestamps and booleans', () => {
    assert.strictEqual(normalizeType('timestamp without time zone'), 'timestamp');
    assert.strictEqual(normalizeType('timestamp with time zone'), 'timestamptz');
    assert.strictEqual(normalizeType('bool'), 'boolean');
  });
});

describe('buildSchemaGraphFromSql()', () => {
  it('parses CREATE TABLE with columns and primary key', () => {
    const sql = `
      CREATE TABLE users (
        id integer PRIMARY KEY,
        email varchar(255) NOT NULL,
        bio text DEFAULT 'hello'
      );
    `;
    const graph = buildSchemaGraphFromSql(sql);
    assert.strictEqual(graph.tables.has('users'), true);

    const tbl = graph.tables.get('users')!;
    assert.strictEqual(tbl.columns.size, 3);
    assert.strictEqual(tbl.columns.get('id')?.isNotNull, false); // primary key implies not null in schema
    assert.strictEqual(tbl.columns.get('email')?.isNotNull, true);
    assert.strictEqual(tbl.columns.get('bio')?.defaultExpr, "'hello'");
  });

  it('parses ALTER TABLE ADD COLUMN and DROP COLUMN', () => {
    const sql = `
      CREATE TABLE orders (id integer);
      ALTER TABLE orders ADD COLUMN total numeric(10,2) NOT NULL DEFAULT 0.00;
      ALTER TABLE orders ADD COLUMN notes text;
      ALTER TABLE orders DROP COLUMN notes;
    `;
    const graph = buildSchemaGraphFromSql(sql);
    const tbl = graph.tables.get('orders')!;

    assert.strictEqual(tbl.columns.has('total'), true);
    assert.strictEqual(tbl.columns.get('total')?.isNotNull, true);
    assert.strictEqual(tbl.columns.get('total')?.defaultExpr, '0.00');
    assert.strictEqual(tbl.columns.has('notes'), false);
  });

  it('parses ALTER TABLE ALTER COLUMN TYPE', () => {
    const sql = `
      CREATE TABLE products (id integer, price int);
      ALTER TABLE products ALTER COLUMN price TYPE numeric(12,2);
    `;
    const graph = buildSchemaGraphFromSql(sql);
    const tbl = graph.tables.get('products')!;

    assert.strictEqual(tbl.columns.get('price')?.dataType, 'numeric(12,2)');
  });

  it('parses CREATE INDEX with CONCURRENTLY and WHERE predicate', () => {
    const sql = `
      CREATE TABLE accounts (id integer, active boolean);
      CREATE INDEX CONCURRENTLY idx_accounts_active ON accounts (id) WHERE active = true;
    `;
    const graph = buildSchemaGraphFromSql(sql);
    assert.strictEqual(graph.indexes.has('idx_accounts_active'), true);

    const idx = graph.indexes.get('idx_accounts_active')!;
    assert.strictEqual(idx.isConcurrent, true);
    assert.strictEqual(idx.table, 'accounts');
    assert.strictEqual(idx.predicate, 'active = true');
  });

  it('parses CREATE TYPE AS ENUM', () => {
    const sql = `
      CREATE TYPE status_type AS ENUM ('draft', 'published', 'archived');
    `;
    const graph = buildSchemaGraphFromSql(sql);
    assert.strictEqual(graph.enums.has('status_type'), true);

    const e = graph.enums.get('status_type')!;
    assert.deepStrictEqual(e.labels, ['draft', 'published', 'archived']);
  });

  it('parses ALTER TABLE ATTACH PARTITION', () => {
    const sql = `
      CREATE TABLE measurement (id int) PARTITION BY RANGE (id);
      ALTER TABLE measurement ATTACH PARTITION measurement_y2026 FOR VALUES FROM (2026) TO (2027);
    `;
    const graph = buildSchemaGraphFromSql(sql);
    assert.strictEqual(graph.partitions.has('measurement->measurement_y2026'), true);
    const p = graph.partitions.get('measurement->measurement_y2026')!;
    assert.strictEqual(p.parentTable, 'measurement');
    assert.strictEqual(p.childTable, 'measurement_y2026');
  });

  it('parses ADD CONSTRAINT with NOT VALID and VALIDATE CONSTRAINT', () => {
    const sql = `
      CREATE TABLE items (id integer, price integer);
      ALTER TABLE items ADD CONSTRAINT chk_positive_price CHECK (price > 0) NOT VALID;
      ALTER TABLE items VALIDATE CONSTRAINT chk_positive_price;
    `;
    const graph = buildSchemaGraphFromSql(sql);
    const con = graph.constraints.get('items.chk_positive_price')!;
    assert.ok(con);
    assert.strictEqual(con.isValidated, true);
  });
});

describe('compareSchemas()', () => {
  it('reports missing table in live database', () => {
    const live = createEmptySchemaGraph();
    const target = buildSchemaGraphFromSql('CREATE TABLE customers (id int);');

    const diff = compareSchemas(live, target);
    assert.strictEqual(diff.missingCount, 1);
    assert.strictEqual(diff.items[0].entityType, 'table');
    assert.strictEqual(diff.items[0].changeType, 'missing');
  });

  it('reports orphaned extra table in live database', () => {
    const live = buildSchemaGraphFromSql('CREATE TABLE legacy_backup (id int);');
    const target = createEmptySchemaGraph();

    const diff = compareSchemas(live, target);
    assert.strictEqual(diff.extraCount, 1);
    assert.strictEqual(diff.items[0].changeType, 'extra');
  });

  it('detects unsafe: adding NOT NULL column without DEFAULT to existing live table', () => {
    const live = buildSchemaGraphFromSql('CREATE TABLE users (id int);');
    const target = buildSchemaGraphFromSql(`
      CREATE TABLE users (id int);
      ALTER TABLE users ADD COLUMN phone varchar(20) NOT NULL;
    `);

    const diff = compareSchemas(live, target);
    assert.strictEqual(diff.hasUnsafe, true);
    assert.strictEqual(diff.unsafeCount, 1);
    assert.strictEqual(diff.items[0].risk, 'BLOCKER');
    assert.ok(diff.items[0].description.includes('NOT NULL column'));
  });

  it('detects safe: adding NOT NULL column WITH default to existing live table', () => {
    const live = buildSchemaGraphFromSql('CREATE TABLE users (id int);');
    const target = buildSchemaGraphFromSql(`
      CREATE TABLE users (id int);
      ALTER TABLE users ADD COLUMN role varchar(20) NOT NULL DEFAULT 'member';
    `);

    const diff = compareSchemas(live, target);
    assert.strictEqual(diff.hasUnsafe, false);
    assert.strictEqual(diff.missingCount, 1);
  });

  it('detects unsafe: column type alteration causing table rewrite', () => {
    const live = buildSchemaGraphFromSql('CREATE TABLE logs (id int, payload varchar(100));');
    const target = buildSchemaGraphFromSql(`
      CREATE TABLE logs (id int);
      ALTER TABLE logs ALTER COLUMN payload TYPE integer;
    `);

    const diff = compareSchemas(live, target);
    assert.strictEqual(diff.hasUnsafe, true);
    assert.strictEqual(diff.items.some(i => i.changeType === 'unsafe' && i.description.includes('type differs')), true);
  });

  it('detects unsafe: CREATE INDEX without CONCURRENTLY', () => {
    const live = buildSchemaGraphFromSql('CREATE TABLE orders (id int);');
    const target = buildSchemaGraphFromSql(`
      CREATE TABLE orders (id int);
      CREATE INDEX idx_orders_id ON orders (id);
    `);

    const diff = compareSchemas(live, target);
    assert.strictEqual(diff.hasUnsafe, true);
    assert.ok(diff.items.some(i => i.changeType === 'unsafe' && i.description.includes('CONCURRENTLY')));
  });

  it('detects unsafe: adding constraint without NOT VALID', () => {
    const live = buildSchemaGraphFromSql('CREATE TABLE orders (id int, amount int);');
    const target = buildSchemaGraphFromSql(`
      CREATE TABLE orders (id int, amount int);
      ALTER TABLE orders ADD CONSTRAINT chk_amount CHECK (amount > 0);
    `);

    const diff = compareSchemas(live, target);
    assert.strictEqual(diff.hasUnsafe, true);
    assert.ok(diff.items.some(i => i.changeType === 'unsafe' && i.description.includes('without NOT VALID')));
  });

  it('detects unvalidated constraint in live database (NOT VALID drift)', () => {
    const live = createEmptySchemaGraph();
    live.tables.set('orders', { name: 'orders', columns: new Map() });
    live.constraints.set('orders.chk_amount', {
      name: 'chk_amount',
      table: 'orders',
      type: 'CHECK',
      definition: 'CHECK (amount > 0)',
      isValidated: false, // NOT VALID in live DB!
    });

    const target = buildSchemaGraphFromSql(`
      CREATE TABLE orders (id int);
      ALTER TABLE orders ADD CONSTRAINT chk_amount CHECK (amount > 0);
    `);

    const diff = compareSchemas(live, target);
    assert.ok(diff.items.some(i => i.changeType === 'changed' && i.description.includes('unvalidated in live DB')));
  });

  it('detects invalid index in live database', () => {
    const live = createEmptySchemaGraph();
    live.tables.set('users', { name: 'users', columns: new Map() });
    live.indexes.set('idx_users_email', {
      name: 'idx_users_email',
      table: 'users',
      isUnique: false,
      columns: ['email'],
      isValid: false, // Invalid build!
    });

    const target = buildSchemaGraphFromSql(`
      CREATE TABLE users (id int);
      CREATE INDEX CONCURRENTLY idx_users_email ON users (email);
    `);

    const diff = compareSchemas(live, target);
    assert.strictEqual(diff.hasUnsafe, true);
    assert.ok(diff.items.some(i => i.description.includes('marked INVALID')));
  });

  it('detects enum label differences', () => {
    const live = createEmptySchemaGraph();
    live.enums.set('status_enum', {
      name: 'status_enum',
      labels: ['active', 'inactive'],
    });

    const target = buildSchemaGraphFromSql(`
      CREATE TYPE status_enum AS ENUM ('active', 'inactive', 'pending', 'suspended');
    `);

    const diff = compareSchemas(live, target);
    assert.strictEqual(diff.changedCount, 1);
    assert.ok(diff.items[0].description.includes('missing labels: pending, suspended'));
  });
});

describe('catalogToSchemaGraph()', () => {
  it('converts CatalogSchema to normalized SchemaGraph', () => {
    const catalog: CatalogSchema = {
      tables: [
        {
          schema: 'public',
          name: 'users',
          kind: 'r',
          isPartitioned: false,
          columns: [
            {
              name: 'id',
              dataType: 'integer',
              isNotNull: true,
              identityType: '',
              defaultExpr: null,
              generatedType: '',
            },
            {
              name: 'name',
              dataType: 'character varying(100)',
              isNotNull: false,
              identityType: '',
              defaultExpr: null,
              generatedType: '',
            },
          ],
        },
      ],
      indexes: [
        {
          schema: 'public',
          table: 'users',
          name: 'idx_users_name',
          isUnique: false,
          isPrimary: false,
          isValid: true,
          isReady: true,
          indexDef: 'CREATE INDEX idx_users_name ON public.users USING btree (name)',
          predicate: null,
          accessMethod: 'btree',
        },
      ],
      constraints: [
        {
          schema: 'public',
          table: 'users',
          name: 'users_pkey',
          type: 'p',
          isValidated: true,
          definition: 'PRIMARY KEY (id)',
          foreignTableSchema: null,
          foreignTableName: null,
        },
      ],
      partitions: [],
      enums: [
        {
          schema: 'public',
          name: 'role_type',
          labels: ['admin', 'user'],
        },
      ],
    };

    const graph = catalogToSchemaGraph(catalog);
    assert.strictEqual(graph.tables.has('users'), true);
    assert.strictEqual(graph.tables.get('users')?.columns.get('name')?.dataType, 'varchar(100)');
    assert.strictEqual(graph.indexes.has('idx_users_name'), true);
    assert.strictEqual(graph.constraints.has('users.users_pkey'), true);
    assert.strictEqual(graph.enums.has('role_type'), true);
  });
});

describe('Formatters', () => {
  it('formatDiffTerminal produces clean output without errors', () => {
    const live = buildSchemaGraphFromSql('CREATE TABLE t (id int);');
    const target = buildSchemaGraphFromSql('CREATE TABLE t (id int); ALTER TABLE t ADD COLUMN unsafe_col text NOT NULL;');
    const diff = compareSchemas(live, target);

    const output = formatDiffTerminal(diff, false);
    assert.ok(output.includes('UNSAFE'));
    assert.ok(output.includes('FAILED:'));
    assert.ok(output.includes('Summary: 1 unsafe'));
  });

  it('formatDiffJson returns valid JSON', () => {
    const live = createEmptySchemaGraph();
    const target = buildSchemaGraphFromSql('CREATE TABLE users (id int);');
    const diff = compareSchemas(live, target);

    const json = formatDiffJson(diff);
    const parsed = JSON.parse(json);
    assert.strictEqual(parsed.missingCount, 1);
    assert.strictEqual(parsed.items.length, 1);
  });
});

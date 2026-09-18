/**
 * ddlforge - Native Ledger Forging Tests (Prisma & Drizzle)
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  computeSha256,
  extractMigrationName,
  forgePrismaLedger,
  forgeDrizzleLedger,
  forgeLedger,
} from '../../src/orchestrator/ledger.js';

describe('Ledger: Hash & Name Extraction', () => {
  it('computes exact SHA-256 hex digest for UTF-8 content', () => {
    const content = 'CREATE TABLE users (id SERIAL PRIMARY KEY);';
    const expected = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
    const actual = computeSha256(content);
    assert.strictEqual(actual, expected);
  });

  it('extracts migration name from Prisma directory structure (.../20260918120000_init/migration.sql)', () => {
    const p1 = 'prisma/migrations/20260918120000_init/migration.sql';
    assert.strictEqual(extractMigrationName(p1), '20260918120000_init');

    const p2 = '/abs/path/prisma/migrations/20260101_add_users/migration.sql';
    assert.strictEqual(extractMigrationName(p2), '20260101_add_users');
  });

  it('extracts migration name from flat sql file (0001_initial.sql)', () => {
    const p = 'drizzle/0001_initial.sql';
    assert.strictEqual(extractMigrationName(p), '0001_initial');
  });
});

describe('Ledger: Prisma Ledger Forging (_prisma_migrations)', () => {
  it('generates valid SQL inserting row with UUIDv4, SHA-256 checksum, and applied_steps_count = 1', () => {
    const filePath = 'prisma/migrations/20260918_add_idx/migration.sql';
    const content = 'CREATE INDEX CONCURRENTLY idx_users ON users (email);';

    const res = forgePrismaLedger(filePath, content);
    assert.strictEqual(res.orm, 'prisma');
    assert.strictEqual(res.migrationName, '20260918_add_idx');
    assert.strictEqual(res.checksum, computeSha256(content));

    // Validate UUIDv4 format (8-4-4-4-12 hex chars)
    const uuidv4Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    assert.match(res.id, uuidv4Regex);

    // Validate generated SQL structure
    assert.ok(res.sql.includes('INSERT INTO "_prisma_migrations"'));
    assert.ok(res.sql.includes('"id"'));
    assert.ok(res.sql.includes('"checksum"'));
    assert.ok(res.sql.includes('"finished_at"'));
    assert.ok(res.sql.includes('"migration_name"'));
    assert.ok(res.sql.includes('"applied_steps_count"'));

    assert.ok(res.sql.includes(`'${res.id}'`));
    assert.ok(res.sql.includes(`'${res.checksum}'`));
    assert.ok(res.sql.includes(`'${res.migrationName}'`));
    assert.ok(res.sql.includes('now()'));
    assert.ok(res.sql.includes('1'));
  });

  it('honors migrationName override when provided', () => {
    const filePath = 'custom/path/migration.sql';
    const content = 'SELECT 1;';
    const res = forgePrismaLedger(filePath, content, 'explicit_migration_name_override');
    assert.strictEqual(res.migrationName, 'explicit_migration_name_override');
    assert.ok(res.sql.includes(`'explicit_migration_name_override'`));
  });

  it('reads content from disk when content string is not supplied', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddlforge-ledger-prisma-'));
    const tmpFile = path.join(tmpDir, 'migration.sql');

    try {
      const sqlContent = 'ALTER TABLE users ADD COLUMN active BOOLEAN DEFAULT TRUE;';
      fs.writeFileSync(tmpFile, sqlContent, 'utf-8');

      const res = forgePrismaLedger(tmpFile);
      assert.strictEqual(res.checksum, computeSha256(sqlContent));
      assert.ok(res.sql.includes(`'${res.checksum}'`));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('Ledger: Drizzle Ledger Forging (drizzle.__drizzle_migrations)', () => {
  it('generates valid SQL with dynamic epoch millisecond timestamp and SHA-256 hash', () => {
    const filePath = 'drizzle/0002_add_index.sql';
    const content = 'CREATE INDEX CONCURRENTLY idx_users ON users (name);';

    const res = forgeDrizzleLedger(filePath, content);
    assert.strictEqual(res.orm, 'drizzle');
    assert.strictEqual(res.hash, computeSha256(content));

    // Validate SQL structure matches Drizzle PostgreSQL migrator
    assert.ok(res.sql.includes('INSERT INTO drizzle.__drizzle_migrations ("hash", "created_at")'));
    assert.ok(res.sql.includes(`VALUES ('${res.hash}', (extract(epoch from now()) * 1000)::bigint);`));
  });

  it('reads content from disk when fileContent parameter is omitted', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddlforge-ledger-drizzle-'));
    const tmpFile = path.join(tmpDir, '0005_orders.sql');

    try {
      const sqlContent = 'CREATE TABLE orders (id INT);';
      fs.writeFileSync(tmpFile, sqlContent, 'utf-8');

      const res = forgeDrizzleLedger(tmpFile);
      assert.strictEqual(res.hash, computeSha256(sqlContent));
      assert.ok(res.sql.includes(res.hash));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('Ledger: Unified forgeLedger Entry Point', () => {
  it('dispatches to Prisma correctly', () => {
    const res = forgeLedger('prisma', 'prisma/migrations/20260918_init/migration.sql', 'SELECT 1;');
    assert.strictEqual(res.orm, 'prisma');
    assert.ok(res.sql.includes('_prisma_migrations'));
  });

  it('dispatches to Drizzle correctly', () => {
    const res = forgeLedger('drizzle', 'drizzle/0001_init.sql', 'SELECT 1;');
    assert.strictEqual(res.orm, 'drizzle');
    assert.ok(res.sql.includes('drizzle.__drizzle_migrations'));
  });

  it('throws for unsupported ORM', () => {
    assert.throws(
      () => forgeLedger('flyway' as any, 'migrations/V1__init.sql', 'SELECT 1;'),
      /Unsupported ORM "flyway"/
    );
  });
});

/**
 * ddlforge - Byte-Offset Statement Slicer & Classifier Tests
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  isAutocommitStatement,
  classifyStatement,
  sliceMigration,
  splitMigrationFile,
} from '../../src/orchestrator/slicer.js';
import { splitStatements } from '../../src/lexer/sqlTokenizer.js';

describe('Slicer: Statement Classification', () => {
  it('classifies CREATE INDEX CONCURRENTLY as AUTOCOMMIT', () => {
    const stmts = splitStatements('CREATE INDEX CONCURRENTLY idx_users_email ON users (email);');
    assert.strictEqual(stmts.length, 1);
    assert.strictEqual(isAutocommitStatement(stmts[0]), true);
    assert.strictEqual(classifyStatement(stmts[0]), 'AUTOCOMMIT');
  });

  it('classifies CREATE UNIQUE INDEX CONCURRENTLY as AUTOCOMMIT', () => {
    const stmts = splitStatements('CREATE UNIQUE INDEX CONCURRENTLY idx_users_email ON users (email);');
    assert.strictEqual(stmts.length, 1);
    assert.strictEqual(classifyStatement(stmts[0]), 'AUTOCOMMIT');
  });

  it('classifies DROP INDEX CONCURRENTLY as AUTOCOMMIT', () => {
    const stmts = splitStatements('DROP INDEX CONCURRENTLY idx_users_email;');
    assert.strictEqual(stmts.length, 1);
    assert.strictEqual(classifyStatement(stmts[0]), 'AUTOCOMMIT');
  });

  it('classifies REINDEX TABLE CONCURRENTLY as AUTOCOMMIT', () => {
    const stmts = splitStatements('REINDEX TABLE CONCURRENTLY users;');
    assert.strictEqual(stmts.length, 1);
    assert.strictEqual(classifyStatement(stmts[0]), 'AUTOCOMMIT');
  });

  it('classifies REINDEX INDEX CONCURRENTLY as AUTOCOMMIT', () => {
    const stmts = splitStatements('REINDEX INDEX CONCURRENTLY idx_orders;');
    assert.strictEqual(stmts.length, 1);
    assert.strictEqual(classifyStatement(stmts[0]), 'AUTOCOMMIT');
  });

  it('classifies VACUUM as AUTOCOMMIT', () => {
    const stmts1 = splitStatements('VACUUM users;');
    assert.strictEqual(classifyStatement(stmts1[0]), 'AUTOCOMMIT');

    const stmts2 = splitStatements('VACUUM FULL orders;');
    assert.strictEqual(classifyStatement(stmts2[0]), 'AUTOCOMMIT');

    const stmts3 = splitStatements('VACUUM ANALYZE accounts;');
    assert.strictEqual(classifyStatement(stmts3[0]), 'AUTOCOMMIT');
  });

  it('classifies ALTER TYPE ... ADD VALUE as AUTOCOMMIT', () => {
    const stmts = splitStatements("ALTER TYPE user_role ADD VALUE 'admin';");
    assert.strictEqual(stmts.length, 1);
    assert.strictEqual(classifyStatement(stmts[0]), 'AUTOCOMMIT');
  });

  it('classifies ALTER TABLE DETACH PARTITION CONCURRENTLY as AUTOCOMMIT', () => {
    const stmts = splitStatements('ALTER TABLE logs DETACH PARTITION logs_2025 CONCURRENTLY;');
    assert.strictEqual(stmts.length, 1);
    assert.strictEqual(classifyStatement(stmts[0]), 'AUTOCOMMIT');
  });

  it('classifies DISCARD ALL as AUTOCOMMIT', () => {
    const stmts = splitStatements('DISCARD ALL;');
    assert.strictEqual(stmts.length, 1);
    assert.strictEqual(classifyStatement(stmts[0]), 'AUTOCOMMIT');
  });

  it('classifies standard DDL as TRANSACTIONAL', () => {
    const ddl = [
      'CREATE TABLE users (id SERIAL PRIMARY KEY, name TEXT);',
      'ALTER TABLE users ADD COLUMN email TEXT;',
      'ALTER TABLE users DROP COLUMN email;',
      'CREATE TABLE orders (id INT);',
      'DROP TABLE old_records;',
      'CREATE VIEW active_users AS SELECT * FROM users;',
    ];

    for (const sql of ddl) {
      const stmts = splitStatements(sql);
      assert.strictEqual(classifyStatement(stmts[0]), 'TRANSACTIONAL', `Expected TRANSACTIONAL for: ${sql}`);
    }
  });

  it('classifies standard DML as TRANSACTIONAL', () => {
    const dml = [
      "INSERT INTO users (name) VALUES ('Alice');",
      "UPDATE users SET name = 'Bob' WHERE id = 1;",
      'DELETE FROM sessions WHERE expired_at < NOW();',
    ];

    for (const sql of dml) {
      const stmts = splitStatements(sql);
      assert.strictEqual(classifyStatement(stmts[0]), 'TRANSACTIONAL', `Expected TRANSACTIONAL for: ${sql}`);
    }
  });
});

describe('Slicer: Byte-Offset Slicing & Formatting Preservation', () => {
  it('preserves exact formatting, inline comments, indentation, and trailing semicolon', () => {
    const sql = `  -- Create user table with custom formatting
  CREATE TABLE users (
    id SERIAL PRIMARY KEY,    -- primary key column
    /* multiline
       email
       comment */
    email TEXT NOT NULL
  );`;

    const result = sliceMigration(sql);
    assert.strictEqual(result.statements.length, 1);

    const s = result.statements[0];
    assert.strictEqual(s.classification, 'TRANSACTIONAL');
    // Sliced text must match original raw text exactly
    assert.strictEqual(s.text.trim(), sql.trim());
    assert.ok(s.text.includes('-- primary key column'));
    assert.ok(s.text.includes('/* multiline'));
  });

  it('slices mixed migration into Phase 1 and Phase 2 with full comment preservation', () => {
    const sql = `-- Migration: Add user bio and concurrent index

-- 1. Create table and add column
CREATE TABLE users (
  id INT
);

-- 2. Concurrently create index on email
CREATE INDEX CONCURRENTLY idx_users_email ON users (email);

-- 3. Add column
ALTER TABLE users ADD COLUMN bio TEXT;

-- 4. Vacuum table
VACUUM ANALYZE users;
`;

    const result = sliceMigration(sql);
    assert.strictEqual(result.isMixed, true);
    assert.strictEqual(result.isClean, false);
    assert.strictEqual(result.phase1Transactional.length, 2); // CREATE TABLE, ALTER TABLE
    assert.strictEqual(result.phase2Autocommit.length, 2);    // CREATE INDEX CONCURRENTLY, VACUUM

    // Phase 1 verification
    assert.ok(result.phase1Sql.includes('CREATE TABLE users'));
    assert.ok(result.phase1Sql.includes('ALTER TABLE users ADD COLUMN bio TEXT;'));
    assert.ok(!result.phase1Sql.includes('CONCURRENTLY'));
    assert.ok(!result.phase1Sql.includes('VACUUM'));

    // Phase 2 verification
    assert.ok(result.phase2Sql.includes('CREATE INDEX CONCURRENTLY idx_users_email'));
    assert.ok(result.phase2Sql.includes('VACUUM ANALYZE users;'));
    assert.ok(!result.phase2Sql.includes('CREATE TABLE'));
    assert.ok(!result.phase2Sql.includes('ADD COLUMN bio'));

    // Verify comments belong to appropriate statements
    assert.ok(result.phase1Sql.includes('-- 1. Create table'));
    assert.ok(result.phase2Sql.includes('-- 2. Concurrently create index'));
    assert.ok(result.phase1Sql.includes('-- 3. Add column'));
    assert.ok(result.phase2Sql.includes('-- 4. Vacuum table'));
  });

  it('handles dollar-quoted functions without splitting internal statements', () => {
    const sql = `CREATE OR REPLACE FUNCTION update_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  -- Semicolon inside function body:
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE INDEX CONCURRENTLY idx_fn ON users (updated_at);
`;

    const result = sliceMigration(sql);
    assert.strictEqual(result.statements.length, 2);
    assert.strictEqual(result.phase1Transactional.length, 1);
    assert.strictEqual(result.phase2Autocommit.length, 1);

    // Verify function body was not cut in half
    assert.ok(result.phase1Sql.includes('NEW.updated_at = NOW();'));
    assert.ok(result.phase1Sql.includes('$$ LANGUAGE plpgsql;'));
    assert.ok(result.phase2Sql.includes('CREATE INDEX CONCURRENTLY idx_fn'));
  });

  it('correctly identifies clean transactional migrations', () => {
    const sql = `
      CREATE TABLE orders (id INT);
      ALTER TABLE orders ADD COLUMN total NUMERIC;
    `;

    const result = sliceMigration(sql);
    assert.strictEqual(result.isClean, true);
    assert.strictEqual(result.isMixed, false);
    assert.strictEqual(result.phase1Transactional.length, 2);
    assert.strictEqual(result.phase2Autocommit.length, 0);
  });

  it('correctly identifies clean autocommit migrations', () => {
    const sql = `
      CREATE INDEX CONCURRENTLY idx_a ON t (a);
      CREATE INDEX CONCURRENTLY idx_b ON t (b);
    `;

    const result = sliceMigration(sql);
    assert.strictEqual(result.isClean, true);
    assert.strictEqual(result.isMixed, false);
    assert.strictEqual(result.phase1Transactional.length, 0);
    assert.strictEqual(result.phase2Autocommit.length, 2);
  });

  it('adds Prisma disable transaction pragma to Phase 2 for Prisma migrations', () => {
    const sql = `-- CreateTable
CREATE TABLE "User" ("id" SERIAL PRIMARY KEY);

-- CreateIndex
CREATE INDEX CONCURRENTLY "User_email_key" ON "User"("email");
`;

    const result = sliceMigration(sql, undefined, { isPrisma: true });
    assert.strictEqual(result.isMixed, true);
    assert.ok(result.phase2Sql.startsWith('-- prisma-migrate-disable-next-transaction'));
    assert.ok(!result.phase1Sql.includes('prisma-migrate-disable-next-transaction'));
  });

  it('handles statement without trailing semicolon at EOF', () => {
    const sql = `CREATE TABLE users (id INT);\nCREATE INDEX CONCURRENTLY idx ON users(id)`;
    const result = sliceMigration(sql);
    assert.strictEqual(result.statements.length, 2);
    assert.strictEqual(result.phase1Transactional.length, 1);
    assert.strictEqual(result.phase2Autocommit.length, 1);
  });
});

describe('Slicer: splitMigrationFile Disk Operations', () => {
  it('splits mixed migration file on disk into _phase1_tx.sql and _phase2_autocommit.sql', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddlforge-slicer-'));
    const sourceFile = path.join(tmpDir, '20260918_mixed.sql');

    try {
      const sql = `ALTER TABLE items ADD COLUMN price INT;\nCREATE INDEX CONCURRENTLY idx_items_price ON items (price);`;
      fs.writeFileSync(sourceFile, sql, 'utf-8');

      const splitRes = splitMigrationFile(sourceFile);
      assert.notStrictEqual(splitRes, null);
      assert.strictEqual(fs.existsSync(splitRes!.phase1Path), true);
      assert.strictEqual(fs.existsSync(splitRes!.phase2Path), true);

      assert.strictEqual(path.basename(splitRes!.phase1Path), '20260918_mixed_phase1_tx.sql');
      assert.strictEqual(path.basename(splitRes!.phase2Path), '20260918_mixed_phase2_autocommit.sql');

      const p1Content = fs.readFileSync(splitRes!.phase1Path, 'utf-8');
      const p2Content = fs.readFileSync(splitRes!.phase2Path, 'utf-8');

      assert.ok(p1Content.includes('ALTER TABLE items ADD COLUMN price INT;'));
      assert.ok(!p1Content.includes('CONCURRENTLY'));

      assert.ok(p2Content.includes('CREATE INDEX CONCURRENTLY idx_items_price ON items (price);'));
      assert.ok(!p2Content.includes('ADD COLUMN price'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns null and leaves disk unaltered for already clean file', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddlforge-slicer-clean-'));
    const sourceFile = path.join(tmpDir, 'clean_tx.sql');

    try {
      const sql = `CREATE TABLE users (id INT);\nALTER TABLE users ADD COLUMN name TEXT;`;
      fs.writeFileSync(sourceFile, sql, 'utf-8');

      const splitRes = splitMigrationFile(sourceFile);
      assert.strictEqual(splitRes, null);

      const files = fs.readdirSync(tmpDir);
      assert.strictEqual(files.length, 1);
      assert.strictEqual(files[0], 'clean_tx.sql');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

/**
 * ddlforge - Orchestrator CLI Subcommands Tests:
 *   - ddlforge split <file.sql>
 *   - ddlforge forge --orm <type> <file.sql>
 *   - ddlforge check --fix <file.sql>
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { runCli } from '../../src/cli.js';
import { analyzeSql } from '../../src/engine/analyzer.js';

describe('CLI: ddlforge split', () => {
  it('splits mixed migration file into phase1_tx and phase2_autocommit files and returns 0', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddlforge-cli-split-'));
    const source = path.join(tmpDir, 'migration.sql');

    try {
      const sql = `-- Step 1: DDL
ALTER TABLE users ADD COLUMN full_name TEXT;

-- Step 2: Concurrent index
CREATE INDEX CONCURRENTLY idx_users_name ON users (full_name);
`;
      fs.writeFileSync(source, sql, 'utf-8');

      const code = await runCli(['split', source]);
      assert.strictEqual(code, 0);

      const p1 = path.join(tmpDir, 'migration_phase1_tx.sql');
      const p2 = path.join(tmpDir, 'migration_phase2_autocommit.sql');

      assert.strictEqual(fs.existsSync(p1), true);
      assert.strictEqual(fs.existsSync(p2), true);

      const c1 = fs.readFileSync(p1, 'utf-8');
      const c2 = fs.readFileSync(p2, 'utf-8');

      assert.ok(c1.includes('ALTER TABLE users ADD COLUMN full_name TEXT;'));
      assert.ok(!c1.includes('CONCURRENTLY'));

      assert.ok(c2.includes('CREATE INDEX CONCURRENTLY idx_users_name'));
      assert.ok(!c2.includes('ADD COLUMN'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('exits with code 0 and does not write files when migration is already clean', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddlforge-cli-split-clean-'));
    const source = path.join(tmpDir, 'clean.sql');

    try {
      fs.writeFileSync(source, 'CREATE TABLE accounts (id SERIAL PRIMARY KEY);', 'utf-8');
      const code = await runCli(['split', source]);
      assert.strictEqual(code, 0);

      // Verify no extra files created
      const entries = fs.readdirSync(tmpDir);
      assert.strictEqual(entries.length, 1);
      assert.strictEqual(entries[0], 'clean.sql');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('exits with code 1 when target file does not exist', async () => {
    const code = await runCli(['split', 'non_existent_migration_file_xyz.sql']);
    assert.strictEqual(code, 1);
  });

  it('exits with code 1 when file argument is omitted', async () => {
    const code = await runCli(['split']);
    assert.strictEqual(code, 1);
  });

  it('exits with code 0 for split --help', async () => {
    const code = await runCli(['split', '--help']);
    assert.strictEqual(code, 0);
  });
});

describe('CLI: ddlforge forge', () => {
  it('outputs ready-to-execute Prisma ledger SQL when --orm prisma is specified', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddlforge-cli-forge-p-'));
    const migrationDir = path.join(tmpDir, 'prisma', 'migrations', '20260918120000_add_search');
    fs.mkdirSync(migrationDir, { recursive: true });
    const source = path.join(migrationDir, 'migration.sql');

    try {
      fs.writeFileSync(source, 'CREATE INDEX CONCURRENTLY idx ON t (a);', 'utf-8');

      // Intercept stdout
      let stdout = '';
      const origLog = console.log;
      console.log = (msg: string) => { stdout += msg + '\n'; };

      try {
        const code = await runCli(['forge', '--orm', 'prisma', source]);
        assert.strictEqual(code, 0);
        assert.ok(stdout.includes('INSERT INTO "_prisma_migrations"'));
        assert.ok(stdout.includes('20260918120000_add_search'));
      } finally {
        console.log = origLog;
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('outputs ready-to-execute Drizzle ledger SQL when --orm drizzle is specified', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddlforge-cli-forge-d-'));
    const source = path.join(tmpDir, '0001_initial.sql');

    try {
      fs.writeFileSync(source, 'CREATE TABLE users (id SERIAL);', 'utf-8');

      let stdout = '';
      const origLog = console.log;
      console.log = (msg: string) => { stdout += msg + '\n'; };

      try {
        const code = await runCli(['forge', '--orm', 'drizzle', source]);
        assert.strictEqual(code, 0);
        assert.ok(stdout.includes('INSERT INTO drizzle.__drizzle_migrations'));
        assert.ok(stdout.includes('(extract(epoch from now()) * 1000)::bigint'));
      } finally {
        console.log = origLog;
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('auto-detects ORM from file path when --orm is omitted', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddlforge-cli-forge-auto-'));
    const prismaDir = path.join(tmpDir, 'prisma', 'migrations', '20260101_init');
    fs.mkdirSync(prismaDir, { recursive: true });
    const source = path.join(prismaDir, 'migration.sql');

    try {
      fs.writeFileSync(source, 'SELECT 1;', 'utf-8');

      let stdout = '';
      const origLog = console.log;
      console.log = (msg: string) => { stdout += msg + '\n'; };

      try {
        const code = await runCli(['forge', source]);
        assert.strictEqual(code, 0);
        assert.ok(stdout.includes('INSERT INTO "_prisma_migrations"'));
      } finally {
        console.log = origLog;
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('exits with code 1 for unsupported ORM', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddlforge-cli-forge-err-'));
    const source = path.join(tmpDir, 'test.sql');

    try {
      fs.writeFileSync(source, 'SELECT 1;', 'utf-8');
      const code = await runCli(['forge', '--orm', 'invalid_orm', source]);
      assert.strictEqual(code, 1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('exits with code 1 when target file does not exist', async () => {
    const code = await runCli(['forge', '--orm', 'prisma', 'non_existent.sql']);
    assert.strictEqual(code, 1);
  });
});

describe('CLI: ddlforge check --fix', () => {
  it('automatically patches ALTER TABLE ADD PRIMARY KEY in-place and passes verification', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddlforge-cli-fix-pk-'));
    const source = path.join(tmpDir, 'unsafe_pk.sql');

    try {
      // Unsafe statement that triggers blocker: add-primary-key-missing-using-index
      fs.writeFileSync(source, 'ALTER TABLE orders ADD PRIMARY KEY (id);', 'utf-8');

      // First verify without --fix it returns 1 (blocker detected)
      const initialCode = await runCli(['check', source, '--quiet']);
      assert.strictEqual(initialCode, 1);

      // Now run with --fix
      const fixCode = await runCli(['check', source, '--fix', '--quiet']);
      assert.strictEqual(fixCode, 0, 'CLI check --fix should return 0 after patching blocker');

      // Verify the file was patched in place
      const patchedSql = fs.readFileSync(source, 'utf-8');
      assert.ok(patchedSql.includes('CREATE UNIQUE INDEX CONCURRENTLY'));
      assert.ok(patchedSql.includes('PRIMARY KEY USING INDEX'));

      // Verify re-analyzing patched file produces 0 blockers
      const verifyRes = analyzeSql(patchedSql);
      assert.strictEqual(verifyRes.blockersCount, 0);
      assert.strictEqual(verifyRes.hasBlockers, false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('automatically patches CREATE INDEX without CONCURRENTLY in-place', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddlforge-cli-fix-idx-'));
    const source = path.join(tmpDir, 'unsafe_idx.sql');

    try {
      fs.writeFileSync(source, 'CREATE INDEX idx_users_email ON users (email);', 'utf-8');

      const fixCode = await runCli(['check', source, '--fix', '--quiet']);
      assert.strictEqual(fixCode, 0);

      const patchedSql = fs.readFileSync(source, 'utf-8');
      assert.ok(patchedSql.includes('CREATE INDEX CONCURRENTLY idx_users_email ON users ( email )'));

      const verifyRes = analyzeSql(patchedSql);
      assert.strictEqual(verifyRes.blockersCount, 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('automatically patches REINDEX TABLE without CONCURRENTLY in-place', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddlforge-cli-fix-reindex-'));
    const source = path.join(tmpDir, 'unsafe_reindex.sql');

    try {
      fs.writeFileSync(source, 'REINDEX TABLE users;', 'utf-8');

      const fixCode = await runCli(['check', source, '--fix', '--quiet']);
      assert.strictEqual(fixCode, 0);

      const patchedSql = fs.readFileSync(source, 'utf-8');
      assert.ok(patchedSql.includes('REINDEX TABLE CONCURRENTLY users;'));

      const verifyRes = analyzeSql(patchedSql);
      assert.strictEqual(verifyRes.blockersCount, 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('automatically patches DETACH PARTITION without CONCURRENTLY in-place', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddlforge-cli-fix-detach-'));
    const source = path.join(tmpDir, 'unsafe_detach.sql');

    try {
      fs.writeFileSync(source, 'ALTER TABLE measurements DETACH PARTITION measurements_2025;', 'utf-8');

      const fixCode = await runCli(['check', source, '--fix', '--quiet']);
      assert.strictEqual(fixCode, 0);

      const patchedSql = fs.readFileSync(source, 'utf-8');
      assert.ok(patchedSql.includes('DETACH PARTITION measurements_2025 CONCURRENTLY;'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('automatically patches CHECK constraint without NOT VALID in-place', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddlforge-cli-fix-chk-'));
    const source = path.join(tmpDir, 'unsafe_chk.sql');

    try {
      fs.writeFileSync(source, 'ALTER TABLE products ADD CONSTRAINT chk_price CHECK (price >= 0);', 'utf-8');

      const fixCode = await runCli(['check', source, '--fix', '--quiet']);
      assert.strictEqual(fixCode, 0);

      const patchedSql = fs.readFileSync(source, 'utf-8');
      assert.ok(patchedSql.includes('NOT VALID;'));
      assert.ok(patchedSql.includes('VALIDATE CONSTRAINT chk_price;'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

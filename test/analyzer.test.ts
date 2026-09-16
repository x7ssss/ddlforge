/**
 * ddlforge - Comprehensive unit and integration test suite using node:test
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  analyzeSql,
  MigrationAnalyzer,
  PostgresLockLevel,
  tokenize,
  splitStatements,
  formatTerminal,
  formatJson,
  formatMarkdown,
  parseArgs,
  discoverSqlFiles,
  runCli,
} from '../src/index.js';

describe('SQL Tokenizer & Statement Splitter', () => {
  it('tokenizes keywords, identifiers, and literals accurately', () => {
    const tokens = tokenize("CREATE TABLE users (id INT, name TEXT DEFAULT 'alice');");
    const keywordValues = tokens.filter(t => t.type === 'KEYWORD').map(t => t.value);
    assert.ok(keywordValues.includes('CREATE'));
    assert.ok(keywordValues.includes('TABLE'));
    assert.ok(keywordValues.includes('DEFAULT'));
  });

  it('handles dollar-quoted strings and escaped quotes', () => {
    const sql = "CREATE OR REPLACE FUNCTION test() RETURNS void AS $$ BEGIN SELECT 'O''Reilly'; END; $$ LANGUAGE plpgsql;";
    const statements = splitStatements(sql);
    assert.strictEqual(statements.length, 1);
    assert.ok(statements[0].raw.includes("$$ BEGIN SELECT 'O''Reilly'; END; $$"));
  });

  it('splits multiple statements on semicolons while respecting comments', () => {
    const sql = `
      -- First statement
      CREATE TABLE test1 (id int);
      /* Multi-line comment ; with semicolon */
      CREATE TABLE test2 (id int);
    `;
    const stmts = splitStatements(sql);
    assert.strictEqual(stmts.length, 2);
    assert.ok(stmts[0].comments.some(c => c.includes('First statement')));
    assert.ok(stmts[1].comments.some(c => c.includes('Multi-line comment')));
  });

  it('detects inline ignore directives', () => {
    const sql = `
      -- ddlforge-ignore require-concurrent-index
      CREATE INDEX idx_users ON users(email);
    `;
    const stmts = splitStatements(sql);
    assert.strictEqual(stmts.length, 1);
    assert.strictEqual(stmts[0].hasIgnore('require-concurrent-index'), true);
    assert.strictEqual(stmts[0].hasIgnore('unbatched-dml'), false);
  });
});

describe('Rule 1: indexConcurrently (require-concurrent-index)', () => {
  it('detects CREATE INDEX without CONCURRENTLY as BLOCKER with SHARE lock', () => {
    const sql = 'CREATE INDEX idx_users_email ON users(email);';
    const res = analyzeSql(sql);
    assert.strictEqual(res.blockersCount, 1);
    const finding = res.findings[0];
    assert.strictEqual(finding.ruleId, 'require-concurrent-index');
    assert.strictEqual(finding.severity, 'BLOCKER');
    assert.strictEqual(finding.lockLevel, PostgresLockLevel.SHARE);
    assert.ok(finding.suggestion.includes('CREATE INDEX CONCURRENTLY'));
  });

  it('detects CREATE UNIQUE INDEX without CONCURRENTLY', () => {
    const sql = 'CREATE UNIQUE INDEX idx_users_email ON users(email);';
    const res = analyzeSql(sql);
    assert.strictEqual(res.blockersCount, 1);
    assert.strictEqual(res.findings[0].lockLevel, PostgresLockLevel.SHARE);
  });

  it('passes CREATE INDEX CONCURRENTLY', () => {
    const sql = 'CREATE INDEX CONCURRENTLY idx_users_email ON users(email);';
    const res = analyzeSql(sql);
    assert.strictEqual(res.blockersCount, 0);
  });

  it('passes when ignored with directive comment', () => {
    const sql = `
      -- ddlforge-ignore require-concurrent-index
      CREATE INDEX idx_users_email ON users(email);
    `;
    const res = analyzeSql(sql);
    assert.strictEqual(res.blockersCount, 0);
  });
});

describe('Rule 2: transactionTrap (concurrent-index-in-transaction)', () => {
  it('detects CREATE INDEX CONCURRENTLY inside explicit transaction block', () => {
    const sql = `
      BEGIN;
      CREATE INDEX CONCURRENTLY idx_users_email ON users(email);
      COMMIT;
    `;
    const res = analyzeSql(sql);
    assert.strictEqual(res.blockersCount, 1);
    const finding = res.findings[0];
    assert.strictEqual(finding.ruleId, 'concurrent-index-in-transaction');
    assert.strictEqual(finding.severity, 'BLOCKER');
    assert.ok(finding.message.includes('explicit transaction block'));
  });

  it('detects DROP INDEX CONCURRENTLY inside explicit transaction block', () => {
    const sql = `
      START TRANSACTION;
      DROP INDEX CONCURRENTLY idx_users_email;
      END;
    `;
    const res = analyzeSql(sql);
    assert.strictEqual(res.blockersCount, 1);
    assert.strictEqual(res.findings[0].ruleId, 'concurrent-index-in-transaction');
  });

  it('detects CONCURRENTLY in Prisma migration without -- prisma:no-transaction', () => {
    const sql = `
      -- CreateIndex
      CREATE INDEX CONCURRENTLY "users_idx" ON "users"("created_at");
    `;
    const res = analyzeSql(sql, { filePath: 'prisma/migrations/20260101_idx/migration.sql' });
    assert.strictEqual(res.blockersCount, 1);
    const finding = res.findings[0];
    assert.strictEqual(finding.ruleId, 'concurrent-index-in-transaction');
    assert.ok(finding.message.includes('-- prisma:no-transaction'));
  });

  it('passes Prisma migration when -- prisma:no-transaction is present', () => {
    const sql = `
      -- prisma:no-transaction
      CREATE INDEX CONCURRENTLY "users_idx" ON "users"("created_at");
    `;
    const res = analyzeSql(sql, { filePath: 'prisma/migrations/20260101_idx/migration.sql' });
    assert.strictEqual(res.blockersCount, 0);
  });
});

describe('Rule 3: addColumnNotNull (add-column-not-null-without-default)', () => {
  it('detects ADD COLUMN NOT NULL without DEFAULT as BLOCKER with ACCESS EXCLUSIVE lock', () => {
    const sql = 'ALTER TABLE users ADD COLUMN age INT NOT NULL;';
    const res = analyzeSql(sql);
    assert.strictEqual(res.blockersCount, 1);
    const finding = res.findings[0];
    assert.strictEqual(finding.ruleId, 'add-column-not-null-without-default');
    assert.strictEqual(finding.severity, 'BLOCKER');
    assert.strictEqual(finding.lockLevel, PostgresLockLevel.ACCESS_EXCLUSIVE);
  });

  it('passes ADD COLUMN nullable', () => {
    const sql = 'ALTER TABLE users ADD COLUMN age INT;';
    const res = analyzeSql(sql);
    assert.strictEqual(res.blockersCount, 0);
  });

  it('passes ADD COLUMN with DEFAULT and NOT NULL', () => {
    const sql = "ALTER TABLE users ADD COLUMN status VARCHAR(20) DEFAULT 'active' NOT NULL;";
    const res = analyzeSql(sql);
    assert.strictEqual(res.blockersCount, 0);
  });

  it('passes ADD COLUMN GENERATED ALWAYS AS IDENTITY', () => {
    const sql = 'ALTER TABLE users ADD COLUMN id_seq INT GENERATED ALWAYS AS IDENTITY;';
    const res = analyzeSql(sql);
    assert.strictEqual(res.blockersCount, 0);
  });
});

describe('Rule 4: foreignKeyNotValid (foreign-key-missing-not-valid)', () => {
  it('detects ADD CONSTRAINT FOREIGN KEY without NOT VALID as BLOCKER with SHARE ROW EXCLUSIVE lock', () => {
    const sql = 'ALTER TABLE orders ADD CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id);';
    const res = analyzeSql(sql);
    assert.strictEqual(res.blockersCount, 1);
    const finding = res.findings[0];
    assert.strictEqual(finding.ruleId, 'foreign-key-missing-not-valid');
    assert.strictEqual(finding.severity, 'BLOCKER');
    assert.strictEqual(finding.lockLevel, PostgresLockLevel.SHARE_ROW_EXCLUSIVE);
    assert.ok(finding.suggestion.includes('NOT VALID'));
  });

  it('passes ADD CONSTRAINT FOREIGN KEY with NOT VALID', () => {
    const sql = 'ALTER TABLE orders ADD CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id) NOT VALID;';
    const res = analyzeSql(sql);
    assert.strictEqual(res.blockersCount, 0);
  });

  it('passes VALIDATE CONSTRAINT statement', () => {
    const sql = 'ALTER TABLE orders VALIDATE CONSTRAINT fk_user;';
    const res = analyzeSql(sql);
    assert.strictEqual(res.blockersCount, 0);
  });
});

describe('Rule 5: prismaRenameDropAdd (prisma-silent-rename-data-loss)', () => {
  it('detects paired DROP COLUMN and ADD COLUMN across separate statements on same table', () => {
    const sql = `
      ALTER TABLE "users" DROP COLUMN "old_name";
      ALTER TABLE "users" ADD COLUMN "new_name" TEXT;
    `;
    const res = analyzeSql(sql);
    const findings = res.findings.filter(f => f.ruleId === 'prisma-silent-rename-data-loss');
    assert.strictEqual(findings.length, 1);
    const finding = findings[0];
    assert.strictEqual(finding.ruleId, 'prisma-silent-rename-data-loss');
    assert.strictEqual(finding.severity, 'BLOCKER');
    assert.ok(finding.message.includes('Destructive column replacement'));
    assert.ok(finding.suggestion.includes('RENAME COLUMN'));
  });

  it('detects paired DROP COLUMN and ADD COLUMN in single ALTER TABLE statement', () => {
    const sql = 'ALTER TABLE "users" DROP COLUMN "old_name", ADD COLUMN "new_name" TEXT;';
    const res = analyzeSql(sql);
    const findings = res.findings.filter(f => f.ruleId === 'prisma-silent-rename-data-loss');
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].ruleId, 'prisma-silent-rename-data-loss');
  });

  it('passes when DROP and ADD are on completely different tables', () => {
    const sql = `
      ALTER TABLE "accounts" DROP COLUMN "temp_token";
      ALTER TABLE "users" ADD COLUMN "new_col" TEXT;
    `;
    const res = analyzeSql(sql);
    assert.strictEqual(res.findings.filter(f => f.ruleId === 'prisma-silent-rename-data-loss').length, 0);
  });

  it('passes safe RENAME COLUMN', () => {
    const sql = 'ALTER TABLE "users" RENAME COLUMN "old_name" TO "new_name";';
    const res = analyzeSql(sql);
    assert.strictEqual(res.blockersCount, 0);
  });
});

describe('Rule 6: setNotNullFullScan (set-not-null-full-scan)', () => {
  it('detects ALTER COLUMN SET NOT NULL as WARNING in PG 16', () => {
    const sql = 'ALTER TABLE users ALTER COLUMN email SET NOT NULL;';
    const res = analyzeSql(sql, { pgVersion: 16 });
    assert.strictEqual(res.warningsCount, 1);
    const finding = res.findings[0];
    assert.strictEqual(finding.ruleId, 'set-not-null-full-scan');
    assert.strictEqual(finding.severity, 'WARNING');
    assert.strictEqual(finding.lockLevel, PostgresLockLevel.ACCESS_EXCLUSIVE);
  });

  it('elevates ALTER COLUMN SET NOT NULL to BLOCKER in PG < 12', () => {
    const sql = 'ALTER TABLE users ALTER COLUMN email SET NOT NULL;';
    const res = analyzeSql(sql, { pgVersion: 11 });
    assert.strictEqual(res.blockersCount, 1);
    assert.strictEqual(res.findings[0].severity, 'BLOCKER');
  });
});

describe('Rule 7: unbatchedBackfill (unbatched-dml)', () => {
  it('detects bare UPDATE without WHERE as BLOCKER', () => {
    const sql = "UPDATE users SET status = 'active';";
    const res = analyzeSql(sql);
    assert.strictEqual(res.blockersCount, 1);
    assert.strictEqual(res.findings[0].ruleId, 'unbatched-dml');
  });

  it('detects UPDATE with WHERE but without batching as WARNING', () => {
    const sql = "UPDATE users SET status = 'active' WHERE created_at < NOW();";
    const res = analyzeSql(sql);
    assert.strictEqual(res.warningsCount, 1);
    assert.strictEqual(res.findings[0].severity, 'WARNING');
  });

  it('passes UPDATE with batch comment', () => {
    const sql = `
      -- batch: 1000
      UPDATE users SET status = 'active' WHERE status = 'pending';
    `;
    const res = analyzeSql(sql);
    assert.strictEqual(res.findings.filter(f => f.ruleId === 'unbatched-dml').length, 0);
  });

  it('passes UPDATE with subquery LIMIT', () => {
    const sql = `
      UPDATE users SET status = 'active'
      WHERE id IN (SELECT id FROM users WHERE status = 'pending' LIMIT 500);
    `;
    const res = analyzeSql(sql);
    assert.strictEqual(res.findings.filter(f => f.ruleId === 'unbatched-dml').length, 0);
  });
});

describe('Reporters: Terminal, JSON, Markdown', () => {
  const sampleSql = 'CREATE INDEX idx_users ON users(email);';
  const analysis = analyzeSql(sampleSql, { filePath: 'migrations/001.sql' });

  it('formats terminal output with ANSI colors and codespans', () => {
    const terminalOutput = formatTerminal([analysis], { color: false });
    assert.ok(terminalOutput.includes('migrations/001.sql'));
    assert.ok(terminalOutput.includes('BLOCKER'));
    assert.ok(terminalOutput.includes('require-concurrent-index'));
    assert.ok(terminalOutput.includes('FAILED'));
  });

  it('formats terminal output respecting --quiet flag', () => {
    const warningSql = "UPDATE users SET status = 'active' WHERE id > 0;";
    const warningAnalysis = analyzeSql(warningSql, { filePath: 'migrations/002.sql' });
    const quietOutput = formatTerminal([warningAnalysis], { quiet: true, color: false });
    // In quiet mode, warnings are suppressed, only blockers are shown
    assert.ok(!quietOutput.includes('WARNING'));
  });

  it('formats valid JSON with correct schema and summary', () => {
    const jsonOutput = formatJson([analysis]);
    const parsed = JSON.parse(jsonOutput);
    assert.strictEqual(parsed.status, 'failed');
    assert.strictEqual(parsed.summary.blockers, 1);
    assert.strictEqual(parsed.summary.filesScanned, 1);
    assert.strictEqual(parsed.findings.length, 1);
    assert.strictEqual(parsed.findings[0].ruleId, 'require-concurrent-index');
  });

  it('formats clean Markdown report for CI PR comments', () => {
    const mdOutput = formatMarkdown([analysis]);
    assert.ok(mdOutput.includes('## 🛡️ ddlforge Migration Lock & Safety Report'));
    assert.ok(mdOutput.includes('Blocking Violations'));
    assert.ok(mdOutput.includes('<details'));
    assert.ok(mdOutput.includes('Suggested Zero-Downtime Fix:'));
  });
});

describe('Fixtures Verification (Safe & Dangerous)', () => {
  const safeDir = path.resolve('test/fixtures/safe');
  const dangerousDir = path.resolve('test/fixtures/dangerous');

  it('validates that all safe fixtures produce 0 blockers', () => {
    const safeFiles = fs.readdirSync(safeDir).filter(f => f.endsWith('.sql'));
    assert.ok(safeFiles.length >= 7, 'Expected at least 7 safe fixture files');

    for (const file of safeFiles) {
      const filePath = path.join(safeDir, file);
      const sql = fs.readFileSync(filePath, 'utf-8');
      const res = analyzeSql(sql, { filePath });
      assert.strictEqual(
        res.blockersCount,
        0,
        `Safe fixture ${file} unexpectedly produced blockers: ${JSON.stringify(res.findings)}`
      );
    }
  });

  it('validates that every dangerous fixture produces at least 1 blocker', () => {
    const dangerousFiles = fs.readdirSync(dangerousDir).filter(f => f.endsWith('.sql'));
    assert.ok(dangerousFiles.length >= 8, 'Expected at least 8 dangerous fixture files');

    for (const file of dangerousFiles) {
      const filePath = path.join(dangerousDir, file);
      const sql = fs.readFileSync(filePath, 'utf-8');
      // For fixture 06_dangerous_set_not_null, test with PG 11 to trigger blocker
      const pgVersion = file.includes('set_not_null') ? 11 : 16;
      const res = analyzeSql(sql, { filePath, pgVersion });
      assert.ok(
        res.blockersCount > 0,
        `Dangerous fixture ${file} expected blockers but got none.`
      );
    }
  });
});

describe('CLI Argument Parser & Discoverer', () => {
  it('parses CLI arguments correctly', () => {
    const options = parseArgs(['./prisma/migrations', '--pg', '14', '--format', 'json', '--quiet', '--changed-only']);
    assert.deepStrictEqual(options.targets, ['./prisma/migrations']);
    assert.strictEqual(options.pgVersion, 14);
    assert.strictEqual(options.format, 'json');
    assert.strictEqual(options.quiet, true);
    assert.strictEqual(options.changedOnly, true);
  });

  it('discovers SQL files from directory recursively', () => {
    const files = discoverSqlFiles(['test/fixtures/safe'], false);
    assert.ok(files.length >= 7);
    assert.ok(files.every(f => f.endsWith('.sql')));
  });

  it('returns exit code 0 for safe fixtures in CLI run', async () => {
    const exitCode = await runCli(['test/fixtures/safe/01_safe_index.sql', '--format', 'json']);
    assert.strictEqual(exitCode, 0);
  });

  it('returns exit code 1 for dangerous fixtures in CLI run', async () => {
    const exitCode = await runCli(['test/fixtures/dangerous/01_dangerous_index.sql', '--format', 'json']);
    assert.strictEqual(exitCode, 1);
  });
});

describe('Sub-second Performance Benchmark', () => {
  it('analyzes 100 migrations in under 100 milliseconds', () => {
    const migrationSql = `
      -- Safe migration with multiple statements
      CREATE INDEX CONCURRENTLY idx_users_email ON users(email);
      ALTER TABLE users ADD COLUMN bio TEXT;
      ALTER TABLE orders ADD CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id) NOT VALID;
      ALTER TABLE orders VALIDATE CONSTRAINT fk_user;
    `;

    const start = performance.now();
    const analyzer = new MigrationAnalyzer();

    for (let i = 0; i < 100; i++) {
      analyzer.analyze(migrationSql, { filePath: `migration_${i}.sql` });
    }

    const elapsed = performance.now() - start;
    assert.ok(elapsed < 100, `Expected 100 migrations analyzed in <100ms, took ${elapsed.toFixed(2)}ms`);
  });
});

/**
 * ddlforge - Unit and integration tests for the ORM migration wrapper
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  parseWrapArgs,
  detectMigrations,
  runPreflightCheck,
  orchestrateWrap,
  spawnCommand,
  runWrap,
} from '../src/wrapper/orchestrator.js';

describe('Wrap CLI: parseWrapArgs()', () => {
  it('parses options before "--" and extracts command after "--"', () => {
    const opts = parseWrapArgs([
      '--dir=./drizzle',
      '--allow-blockers',
      '--db=postgres://localhost:5432/test',
      '--',
      'npx',
      'drizzle-kit',
      'migrate',
    ]);

    assert.strictEqual(opts.dir, './drizzle');
    assert.strictEqual(opts.allowBlockers, true);
    assert.strictEqual(opts.databaseUrl, 'postgres://localhost:5432/test');
    assert.deepStrictEqual(opts.command, ['npx', 'drizzle-kit', 'migrate']);
    assert.strictEqual(opts.help, false);
  });

  it('handles separated flag values e.g. --dir <path> and --db <url>', () => {
    const opts = parseWrapArgs([
      '--dir',
      './prisma/migrations',
      '--db',
      'postgres://user:pass@host/db',
      '--',
      'npx',
      'prisma',
      'migrate',
      'deploy',
    ]);

    assert.strictEqual(opts.dir, './prisma/migrations');
    assert.strictEqual(opts.databaseUrl, 'postgres://user:pass@host/db');
    assert.deepStrictEqual(opts.command, ['npx', 'prisma', 'migrate', 'deploy']);
  });

  it('detects --help flag', () => {
    const opts = parseWrapArgs(['--help']);
    assert.strictEqual(opts.help, true);
  });

  it('handles positional command when "--" is omitted', () => {
    const opts = parseWrapArgs(['--allow-blockers', 'npx', 'prisma', 'migrate']);
    assert.strictEqual(opts.allowBlockers, true);
    assert.deepStrictEqual(opts.command, ['npx', 'prisma', 'migrate']);
  });
});

describe('Wrap Orchestrator: detectMigrations()', () => {
  it('detects Prisma-style folder layouts (prisma/migrations/20260916_init/migration.sql)', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddlforge-prisma-'));
    try {
      const migrationDir = path.join(tempDir, 'prisma', 'migrations', '20260916_init');
      fs.mkdirSync(migrationDir, { recursive: true });
      fs.writeFileSync(
        path.join(migrationDir, 'migration.sql'),
        'CREATE TABLE users (id SERIAL PRIMARY KEY);'
      );

      const migrations = detectMigrations(undefined, tempDir);
      assert.strictEqual(migrations.length, 1);
      assert.strictEqual(migrations[0].name, '20260916_init');
      assert.strictEqual(migrations[0].projectType, 'prisma');
      assert.strictEqual(
        migrations[0].filePath,
        path.join(migrationDir, 'migration.sql')
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('detects Drizzle-style flat layout (drizzle/*.sql)', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddlforge-drizzle-'));
    try {
      const drizzleDir = path.join(tempDir, 'drizzle');
      fs.mkdirSync(drizzleDir, { recursive: true });
      fs.writeFileSync(
        path.join(drizzleDir, '0000_init.sql'),
        'CREATE TABLE posts (id SERIAL PRIMARY KEY);'
      );
      fs.writeFileSync(
        path.join(drizzleDir, '0001_users.sql'),
        'CREATE TABLE users (id SERIAL PRIMARY KEY);'
      );

      const migrations = detectMigrations(undefined, tempDir);
      assert.strictEqual(migrations.length, 2);
      assert.strictEqual(migrations[0].name, '0000_init.sql');
      assert.strictEqual(migrations[0].projectType, 'drizzle');
      assert.strictEqual(migrations[1].name, '0001_users.sql');
      assert.strictEqual(migrations[1].projectType, 'drizzle');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('supports explicit --dir override pointing to a custom directory', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddlforge-custom-'));
    try {
      const customDir = path.join(tempDir, 'custom_sql');
      fs.mkdirSync(customDir, { recursive: true });
      fs.writeFileSync(
        path.join(customDir, 'migration1.sql'),
        'CREATE TABLE t1 (id INT);'
      );

      const migrations = detectMigrations(customDir, tempDir);
      assert.strictEqual(migrations.length, 1);
      assert.strictEqual(migrations[0].name, 'migration1.sql');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('returns empty array if directory does not exist or has no migrations', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddlforge-empty-'));
    try {
      const migrations = detectMigrations(undefined, tempDir);
      assert.strictEqual(migrations.length, 0);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('Wrap Orchestrator: Pre-flight Safety Interception', () => {
  it('detects blockers when a dangerous migration is present', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddlforge-danger-'));
    try {
      const migrationDir = path.join(tempDir, 'prisma', 'migrations', '20260916_unsafe');
      fs.mkdirSync(migrationDir, { recursive: true });
      // Unsafe: ADD COLUMN NOT NULL without default
      fs.writeFileSync(
        path.join(migrationDir, 'migration.sql'),
        'ALTER TABLE users ADD COLUMN email TEXT NOT NULL;'
      );

      const migrations = detectMigrations(undefined, tempDir);
      const results = runPreflightCheck(migrations);
      const blockers = results.reduce((sum, r) => sum + r.blockersCount, 0);
      assert.ok(blockers > 0, `Expected blockers but found ${blockers}`);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('aborts without running command when dangerous migration is present and allowBlockers=false', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddlforge-abort-'));
    const canaryFile = path.join(tempDir, 'canary.txt');
    try {
      const migrationDir = path.join(tempDir, 'prisma', 'migrations', '20260916_unsafe');
      fs.mkdirSync(migrationDir, { recursive: true });
      fs.writeFileSync(
        path.join(migrationDir, 'migration.sql'),
        'CREATE INDEX idx_users_email ON users(email);' // Blocker: missing CONCURRENTLY
      );

      // Dummy command that touches canary.txt if executed
      const result = await orchestrateWrap({
        cwd: tempDir,
        allowBlockers: false,
        command: ['node', '-e', `require('fs').writeFileSync(${JSON.stringify(canaryFile)}, 'ran')`],
      });

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.exitCode, 1);
      assert.ok(result.blockersCount > 0);
      assert.strictEqual(result.executedCommand, false);
      assert.strictEqual(fs.existsSync(canaryFile), false, 'Command should NOT have executed');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('runs command when allowBlockers=true even if blockers are detected', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddlforge-allow-'));
    const canaryFile = path.join(tempDir, 'canary.txt');
    try {
      const migrationDir = path.join(tempDir, 'prisma', 'migrations', '20260916_unsafe');
      fs.mkdirSync(migrationDir, { recursive: true });
      fs.writeFileSync(
        path.join(migrationDir, 'migration.sql'),
        'CREATE INDEX idx_users_email ON users(email);'
      );

      const result = await orchestrateWrap({
        cwd: tempDir,
        allowBlockers: true,
        command: ['node', '-e', `require('fs').writeFileSync(${JSON.stringify(canaryFile)}, 'ran')`],
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.exitCode, 0);
      assert.ok(result.blockersCount > 0);
      assert.strictEqual(result.executedCommand, true);
      assert.strictEqual(fs.existsSync(canaryFile), true, 'Command SHOULD have executed');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('Wrap Orchestrator: Execution Delegation', () => {
  it('successfully spawns and executes dummy safe command (node -e "process.exit(0)")', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddlforge-safe-'));
    try {
      const migrationDir = path.join(tempDir, 'drizzle');
      fs.mkdirSync(migrationDir, { recursive: true });
      // Safe migration
      fs.writeFileSync(
        path.join(migrationDir, '0000_safe.sql'),
        'CREATE TABLE test (id INT);'
      );

      const result = await orchestrateWrap({
        cwd: tempDir,
        allowBlockers: false,
        command: ['node', '-e', 'process.exit(0)'],
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.exitCode, 0);
      assert.strictEqual(result.blockersCount, 0);
      assert.strictEqual(result.executedCommand, true);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('propagates child process non-zero exit code cleanly', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddlforge-exitcode-'));
    try {
      const result = await orchestrateWrap({
        cwd: tempDir,
        command: ['node', '-e', 'process.exit(42)'],
      });

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.exitCode, 42);
      assert.strictEqual(result.executedCommand, true);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('spawnCommand runs command and returns exit code 0 on success', async () => {
    const code = await spawnCommand(['node', '-e', 'process.exit(0)']);
    assert.strictEqual(code, 0);
  });

  it('spawnCommand returns non-zero code on failure', async () => {
    const code = await spawnCommand(['node', '-e', 'process.exit(7)']);
    assert.strictEqual(code, 7);
  });
});

describe('Wrap CLI: runWrap() entry point', () => {
  it('returns exit code 0 when command succeeds in safe environment', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddlforge-cli-'));
    try {
      const exitCode = await runWrap(['--', 'node', '-e', 'process.exit(0)'], tempDir);
      assert.strictEqual(exitCode, 0);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('returns exit code 1 when missing command', async () => {
    const exitCode = await runWrap(['--allow-blockers']);
    assert.strictEqual(exitCode, 1);
  });

  it('returns exit code 0 for --help', async () => {
    const exitCode = await runWrap(['--help']);
    assert.strictEqual(exitCode, 0);
  });
});

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runCircuitBreaker, runTop, runCli } from '../../src/cli.js';

describe('CLI subcommands: ddlforge run & ddlforge top', () => {
  const tmpDir = os.tmpdir();
  const sampleSqlFile = path.join(tmpDir, 'ddlforge_sample_migration.sql');

  // Ensure test file exists
  fs.writeFileSync(sampleSqlFile, 'ALTER TABLE users ADD COLUMN age int;');

  describe('run subcommand (Circuit Breaker)', () => {
    it('prints help and exits 0 on --help', async () => {
      const exitCode = await runCircuitBreaker(['--help']);
      assert.strictEqual(exitCode, 0);
    });

    it('prints help and exits 0 on -h', async () => {
      const exitCode = await runCircuitBreaker(['-h']);
      assert.strictEqual(exitCode, 0);
    });

    it('returns exit code 1 when no SQL file is provided', async () => {
      const exitCode = await runCircuitBreaker([]);
      assert.strictEqual(exitCode, 1);
    });

    it('returns exit code 1 when file does not exist', async () => {
      const exitCode = await runCircuitBreaker(['this_file_does_not_exist_at_all.sql']);
      assert.strictEqual(exitCode, 1);
    });

    it('returns exit code 1 when DB URL is missing', async () => {
      const savedEnv = process.env['DATABASE_URL'];
      delete process.env['DATABASE_URL'];
      try {
        const exitCode = await runCircuitBreaker([sampleSqlFile]);
        assert.strictEqual(exitCode, 1);
      } finally {
        if (savedEnv !== undefined) {
          process.env['DATABASE_URL'] = savedEnv;
        }
      }
    });

    it('dispatches properly through runCli("run", "--help")', async () => {
      const exitCode = await runCli(['run', '--help']);
      assert.strictEqual(exitCode, 0);
    });
  });

  describe('top subcommand (Deadlock Visualizer)', () => {
    it('prints help and exits 0 on --help', async () => {
      const exitCode = await runTop(['--help']);
      assert.strictEqual(exitCode, 0);
    });

    it('prints help and exits 0 on -h', async () => {
      const exitCode = await runTop(['-h']);
      assert.strictEqual(exitCode, 0);
    });

    it('returns exit code 1 when DB URL is missing', async () => {
      const savedEnv = process.env['DATABASE_URL'];
      delete process.env['DATABASE_URL'];
      try {
        const exitCode = await runTop([]);
        assert.strictEqual(exitCode, 1);
      } finally {
        if (savedEnv !== undefined) {
          process.env['DATABASE_URL'] = savedEnv;
        }
      }
    });

    it('dispatches properly through runCli("top", "--help")', async () => {
      const exitCode = await runCli(['top', '--help']);
      assert.strictEqual(exitCode, 0);
    });
  });
});

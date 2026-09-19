import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { runPreflight, runCli } from '../../src/cli.js';

describe('Pre-flight CLI Subcommand (ddlforge preflight)', () => {
  describe('help screens', () => {
    it('prints help and exits 0 on --help', async () => {
      const exitCode = await runPreflight(['--help']);
      assert.strictEqual(exitCode, 0);
    });

    it('prints help and exits 0 via runCli(["preflight", "--help"])', async () => {
      const exitCode = await runCli(['preflight', '--help']);
      assert.strictEqual(exitCode, 0);
    });
  });

  describe('offline / simulation mode', () => {
    it('runs simulation with defaults and exits 0', async () => {
      const exitCode = await runPreflight([]);
      assert.strictEqual(exitCode, 0);
    });

    it('runs simulation for create_index with custom tuple count', async () => {
      const exitCode = await runPreflight([
        '--target-table', 'events',
        '--operation', 'create_index',
        '--tuples', '5000000',
        '--available-bytes', '100000000000',
      ]);
      assert.strictEqual(exitCode, 0);
    });

    it('runs simulation for table_rewrite and outputs JSON', async () => {
      const exitCode = await runPreflight([
        '--target-table', 'users',
        '--operation', 'table_rewrite',
        '--table-bytes', '5000000000',
        '--toast-bytes', '1000000000',
        '--format', 'json',
      ]);
      assert.strictEqual(exitCode, 0);
    });

    it('exits with 1 when available disk space is insufficient for simulation', async () => {
      const exitCode = await runPreflight([
        '--target-table', 'massive_table',
        '--operation', 'table_rewrite',
        '--table-bytes', '50000000000', // 50 GB
        '--available-bytes', '1000000000', // 1 GB (insufficient)
      ]);
      assert.strictEqual(exitCode, 1);
    });

    it('handles non-existent migration file gracefully', async () => {
      const exitCode = await runPreflight(['non_existent_file.sql']);
      assert.strictEqual(exitCode, 1);
    });
  });
});

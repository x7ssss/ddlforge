import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { runDoctor, runVerifyBackup, runCli, runPreflight, runCircuitBreaker } from '../../src/cli.js';

describe('Disaster Recovery & Backup Verification CLI (src/cli.ts)', () => {
  describe('ddlforge doctor help and argument validation', () => {
    it('prints help and exits 0 on --help', async () => {
      const exitCode = await runDoctor(['--help']);
      assert.strictEqual(exitCode, 0);
    });

    it('prints help and exits 0 via runCli(["doctor", "--help"])', async () => {
      const exitCode = await runCli(['doctor', '--help']);
      assert.strictEqual(exitCode, 0);
    });

    it('exits with 1 when database connection URL is missing', async () => {
      const oldEnv = process.env['DATABASE_URL'];
      delete process.env['DATABASE_URL'];
      try {
        const exitCode = await runDoctor([]);
        assert.strictEqual(exitCode, 1);
      } finally {
        if (oldEnv !== undefined) {
          process.env['DATABASE_URL'] = oldEnv;
        }
      }
    });
  });

  describe('ddlforge verify-backup help and argument validation', () => {
    it('prints help and exits 0 on --help', async () => {
      const exitCode = await runVerifyBackup(['--help']);
      assert.strictEqual(exitCode, 0);
    });

    it('prints help and exits 0 via runCli(["verify-backup", "--help"])', async () => {
      const exitCode = await runCli(['verify-backup', '--help']);
      assert.strictEqual(exitCode, 0);
    });

    it('exits with 1 when target database URL is missing', async () => {
      const oldEnv = process.env['DATABASE_URL'];
      delete process.env['DATABASE_URL'];
      try {
        const exitCode = await runVerifyBackup([]);
        assert.strictEqual(exitCode, 1);
      } finally {
        if (oldEnv !== undefined) {
          process.env['DATABASE_URL'] = oldEnv;
        }
      }
    });
  });

  describe('ddlforge preflight & run DR options help screens', () => {
    it('displays disaster recovery options on preflight --help', async () => {
      let output = '';
      const origLog = console.log;
      console.log = (msg: any) => { output += String(msg) + '\n'; };

      try {
        const code = await runPreflight(['--help']);
        assert.strictEqual(code, 0);
        assert.match(output, /--force-no-backup/);
        assert.match(output, /--rpo-hours/);
        assert.match(output, /--backup-provider/);
      } finally {
        console.log = origLog;
      }
    });

    it('displays disaster recovery options on run --help', async () => {
      let output = '';
      const origLog = console.log;
      console.log = (msg: any) => { output += String(msg) + '\n'; };

      try {
        const code = await runCircuitBreaker(['--help']);
        assert.strictEqual(code, 0);
        assert.match(output, /--force-no-backup/);
        assert.match(output, /--rpo-hours/);
        assert.match(output, /--backup-provider/);
      } finally {
        console.log = origLog;
      }
    });
  });
});

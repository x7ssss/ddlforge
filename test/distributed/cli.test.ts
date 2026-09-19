import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { runTenant, runCli, printHelp } from '../../src/cli.js';

describe('Multi-Tenant CLI Subcommands (src/cli.ts)', () => {
  describe('General tenant routing and help', () => {
    it('prints help and exits 0 on --help', async () => {
      const exitCode = await runTenant(['--help']);
      assert.strictEqual(exitCode, 0);
    });

    it('prints help and exits 0 via runCli(["tenant", "--help"])', async () => {
      const exitCode = await runCli(['tenant', '--help']);
      assert.strictEqual(exitCode, 0);
    });

    it('exits 1 on unknown subcommand', async () => {
      const exitCode = await runTenant(['unknown_sub']);
      assert.strictEqual(exitCode, 1);
    });

    it('includes tenant documentation in main printHelp()', () => {
      let output = '';
      const origLog = console.log;
      console.log = (msg: any) => { output += String(msg) + '\n'; };
      try {
        printHelp();
      } finally {
        console.log = origLog;
      }
      assert.ok(output.includes('TENANT (multi-tenant distribution & drift auditing)'));
      assert.ok(output.includes('ddlforge tenant migrate'));
      assert.ok(output.includes('ddlforge tenant audit'));
      assert.ok(output.includes('ddlforge tenant sweep'));
    });
  });

  describe('ddlforge tenant migrate', () => {
    it('prints help and exits 0 on migrate --help', async () => {
      const exitCode = await runTenant(['migrate', '--help']);
      assert.strictEqual(exitCode, 0);
    });

    it('exits 1 when database connection URL is missing for schema strategy', async () => {
      const oldEnv = process.env['DATABASE_URL'];
      delete process.env['DATABASE_URL'];
      try {
        const exitCode = await runTenant(['migrate', '--strategy', 'schema']);
        assert.strictEqual(exitCode, 1);
      } finally {
        if (oldEnv !== undefined) {
          process.env['DATABASE_URL'] = oldEnv;
        }
      }
    });

    it('exits 1 when neither config nor db is provided for database strategy', async () => {
      const oldEnv = process.env['DATABASE_URL'];
      delete process.env['DATABASE_URL'];
      try {
        const exitCode = await runTenant(['migrate', '--strategy', 'database']);
        assert.strictEqual(exitCode, 1);
      } finally {
        if (oldEnv !== undefined) {
          process.env['DATABASE_URL'] = oldEnv;
        }
      }
    });

    it('exits 1 when migration file does not exist', async () => {
      const exitCode = await runTenant([
        'migrate',
        '--strategy', 'database',
        '--config', 'fixtures/tenants.json',
        '--file', 'nonexistent_migration.sql',
      ]);
      assert.strictEqual(exitCode, 1);
    });
  });

  describe('ddlforge tenant audit', () => {
    it('prints help and exits 0 on audit --help', async () => {
      const exitCode = await runTenant(['audit', '--help']);
      assert.strictEqual(exitCode, 0);
    });

    it('exits 1 when database connection URL is missing', async () => {
      const oldEnv = process.env['DATABASE_URL'];
      delete process.env['DATABASE_URL'];
      try {
        const exitCode = await runTenant(['audit']);
        assert.strictEqual(exitCode, 1);
      } finally {
        if (oldEnv !== undefined) {
          process.env['DATABASE_URL'] = oldEnv;
        }
      }
    });
  });

  describe('ddlforge tenant sweep', () => {
    it('prints help and exits 0 on sweep --help', async () => {
      const exitCode = await runTenant(['sweep', '--help']);
      assert.strictEqual(exitCode, 0);
    });

    it('exits 1 when database connection URL is missing', async () => {
      const oldEnv = process.env['DATABASE_URL'];
      delete process.env['DATABASE_URL'];
      try {
        const exitCode = await runTenant(['sweep']);
        assert.strictEqual(exitCode, 1);
      } finally {
        if (oldEnv !== undefined) {
          process.env['DATABASE_URL'] = oldEnv;
        }
      }
    });
  });
});

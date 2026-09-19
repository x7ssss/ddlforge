import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { runAdvisor, runCli, printHelp } from '../../src/cli.js';

describe('Advisor CLI Subcommands (src/cli.ts)', () => {
  describe('General advisor routing and help', () => {
    it('prints help and exits 0 on --help', async () => {
      const exitCode = await runAdvisor(['--help']);
      assert.strictEqual(exitCode, 0);
    });

    it('prints help and exits 0 via runCli(["advisor", "--help"])', async () => {
      const exitCode = await runCli(['advisor', '--help']);
      assert.strictEqual(exitCode, 0);
    });

    it('exits 1 on unknown subcommand', async () => {
      const exitCode = await runAdvisor(['unknown_command']);
      assert.strictEqual(exitCode, 1);
    });

    it('includes advisor documentation in main printHelp()', () => {
      let output = '';
      const origLog = console.log;
      console.log = (msg: any) => {
        output += String(msg) + '\n';
      };
      try {
        printHelp();
      } finally {
        console.log = origLog;
      }
      assert.ok(output.includes('ADVISOR (query telemetry, hypopg simulation & index pruner)'));
      assert.ok(output.includes('ddlforge advisor analyze'));
      assert.ok(output.includes('ddlforge advisor simulate'));
      assert.ok(output.includes('ddlforge advisor prune'));
    });
  });

  describe('ddlforge advisor analyze', () => {
    it('prints help and exits 0 on analyze --help', async () => {
      const exitCode = await runAdvisor(['analyze', '--help']);
      assert.strictEqual(exitCode, 0);
    });

    it('exits 1 when database connection URL is missing', async () => {
      const oldEnv = process.env['DATABASE_URL'];
      delete process.env['DATABASE_URL'];
      try {
        const exitCode = await runAdvisor(['analyze']);
        assert.strictEqual(exitCode, 1);
      } finally {
        if (oldEnv !== undefined) {
          process.env['DATABASE_URL'] = oldEnv;
        }
      }
    });
  });

  describe('ddlforge advisor simulate', () => {
    it('prints help and exits 0 on simulate --help', async () => {
      const exitCode = await runAdvisor(['simulate', '--help']);
      assert.strictEqual(exitCode, 0);
    });

    it('exits 1 when database connection URL is missing', async () => {
      const oldEnv = process.env['DATABASE_URL'];
      delete process.env['DATABASE_URL'];
      try {
        const exitCode = await runAdvisor([
          'simulate',
          '--query', 'SELECT 1',
          '--index', 'CREATE INDEX idx ON t (a)',
        ]);
        assert.strictEqual(exitCode, 1);
      } finally {
        if (oldEnv !== undefined) {
          process.env['DATABASE_URL'] = oldEnv;
        }
      }
    });

    it('exits 1 when query or index SQL is missing', async () => {
      const exitCode = await runAdvisor([
        'simulate',
        '--db', 'postgres://localhost/test',
        '--query', 'SELECT 1',
      ]);
      assert.strictEqual(exitCode, 1);
    });
  });

  describe('ddlforge advisor prune', () => {
    it('prints help and exits 0 on prune --help', async () => {
      const exitCode = await runAdvisor(['prune', '--help']);
      assert.strictEqual(exitCode, 0);
    });

    it('exits 1 when database connection URL is missing', async () => {
      const oldEnv = process.env['DATABASE_URL'];
      delete process.env['DATABASE_URL'];
      try {
        const exitCode = await runAdvisor(['prune']);
        assert.strictEqual(exitCode, 1);
      } finally {
        if (oldEnv !== undefined) {
          process.env['DATABASE_URL'] = oldEnv;
        }
      }
    });
  });
});

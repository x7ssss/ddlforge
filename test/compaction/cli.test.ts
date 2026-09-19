import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { runCompact, runCli, printHelp } from '../../src/cli.js';

describe('Compaction CLI Subcommands (src/cli.ts)', () => {
  describe('General compact help and routing', () => {
    it('prints help and exits 0 on --help', async () => {
      const exitCode = await runCompact(['--help']);
      assert.strictEqual(exitCode, 0);
    });

    it('prints help and exits 0 via runCli(["compact", "--help"])', async () => {
      const exitCode = await runCli(['compact', '--help']);
      assert.strictEqual(exitCode, 0);
    });

    it('exits 1 on unknown compaction subcommand', async () => {
      const exitCode = await runCompact(['unknown_sub']);
      assert.strictEqual(exitCode, 1);
    });

    it('includes compaction documentation in main printHelp()', () => {
      let output = '';
      const origLog = console.log;
      console.log = (msg: any) => { output += String(msg) + '\n'; };
      try {
        printHelp();
      } finally {
        console.log = origLog;
      }
      assert.ok(output.includes('COMPACT (zero-downtime table compaction & bloat estimator)'));
      assert.ok(output.includes('ddlforge compact estimate'));
      assert.ok(output.includes('ddlforge compact table'));
      assert.ok(output.includes('ddlforge compact index'));
    });
  });

  describe('ddlforge compact estimate', () => {
    it('prints help and exits 0 on estimate --help', async () => {
      const exitCode = await runCompact(['estimate', '--help']);
      assert.strictEqual(exitCode, 0);
    });

    it('exits 1 when database connection URL is missing', async () => {
      const oldEnv = process.env['DATABASE_URL'];
      delete process.env['DATABASE_URL'];
      try {
        const exitCode = await runCompact(['estimate']);
        assert.strictEqual(exitCode, 1);
      } finally {
        if (oldEnv !== undefined) {
          process.env['DATABASE_URL'] = oldEnv;
        }
      }
    });
  });

  describe('ddlforge compact table', () => {
    it('prints help and exits 0 on table --help', async () => {
      const exitCode = await runCompact(['table', '--help']);
      assert.strictEqual(exitCode, 0);
    });

    it('exits 1 when --table flag is missing', async () => {
      const exitCode = await runCompact(['table']);
      assert.strictEqual(exitCode, 1);
    });

    it('generates online repack SQL script to terminal', async () => {
      let output = '';
      const origLog = console.log;
      console.log = (msg: any) => { output += String(msg) + '\n'; };
      try {
        const exitCode = await runCompact([
          'table',
          '--table', 'orders',
          '--pk', 'id',
          '--batch-size', '5000',
          '--throttle-ms', '15',
        ]);
        assert.strictEqual(exitCode, 0);
      } finally {
        console.log = origLog;
      }

      assert.ok(output.includes('Zero-Downtime Table Compaction Script (Online Repack)'));
      assert.ok(output.includes('PHASE 1: SHADOW TABLE SETUP'));
      assert.ok(output.includes('PHASE 5: BOUNDED ATOMIC CUTOVER'));
      assert.ok(output.includes('"orders_repack_shadow"'));
    });

    it('outputs structured JSON when --format json is specified', async () => {
      let output = '';
      const origLog = console.log;
      console.log = (msg: any) => { output += String(msg) + '\n'; };
      try {
        const exitCode = await runCompact([
          'table',
          '--table=users',
          '--pk=user_id',
          '--format=json',
        ]);
        assert.strictEqual(exitCode, 0);
      } finally {
        console.log = origLog;
      }

      const parsed = JSON.parse(output);
      assert.strictEqual(parsed.table, 'users');
      assert.strictEqual(parsed.primaryKey, 'user_id');
      assert.ok(parsed.phases.phase1);
      assert.ok(parsed.phases.phase5);
      assert.ok(parsed.fullSql);
    });
  });

  describe('ddlforge compact index', () => {
    it('prints help and exits 0 on index --help', async () => {
      const exitCode = await runCompact(['index', '--help']);
      assert.strictEqual(exitCode, 0);
    });

    it('exits 1 when --table flag is missing', async () => {
      const exitCode = await runCompact(['index']);
      assert.strictEqual(exitCode, 1);
    });

    it('generates concurrent index rebuild SQL for specific index', async () => {
      let output = '';
      const origLog = console.log;
      console.log = (msg: any) => { output += String(msg) + '\n'; };
      try {
        const exitCode = await runCompact([
          'index',
          '--table', 'orders',
          '--index', 'idx_orders_customer',
        ]);
        assert.strictEqual(exitCode, 0);
      } finally {
        console.log = origLog;
      }

      assert.ok(output.includes('REINDEX INDEX CONCURRENTLY "public"."idx_orders_customer";'));
      assert.ok(output.includes('ShareUpdateExclusiveLock'));
    });

    it('generates concurrent table reindex SQL when index is omitted', async () => {
      let output = '';
      const origLog = console.log;
      console.log = (msg: any) => { output += String(msg) + '\n'; };
      try {
        const exitCode = await runCompact([
          'index',
          '--table=transactions',
          '--schema=billing',
        ]);
        assert.strictEqual(exitCode, 0);
      } finally {
        console.log = origLog;
      }

      assert.ok(output.includes('REINDEX TABLE CONCURRENTLY "billing"."transactions";'));
    });
  });
});

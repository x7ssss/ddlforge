import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { runPartition, runCli } from '../../src/cli.js';

describe('Partition CLI subcommands (ddlforge partition)', () => {
  describe('help screens', () => {
    it('prints help and exits 0 on --help', async () => {
      const exitCode = await runPartition(['--help']);
      assert.strictEqual(exitCode, 0);
    });

    it('prints help and exits 0 when no args are passed', async () => {
      const exitCode = await runPartition([]);
      assert.strictEqual(exitCode, 0);
    });

    it('prints help for convert subcommand', async () => {
      const exitCode = await runPartition(['convert', '--help']);
      assert.strictEqual(exitCode, 0);
    });

    it('prints help for attach subcommand', async () => {
      const exitCode = await runPartition(['attach', '--help']);
      assert.strictEqual(exitCode, 0);
    });

    it('prints help for detach subcommand', async () => {
      const exitCode = await runPartition(['detach', '--help']);
      assert.strictEqual(exitCode, 0);
    });

    it('prints help for maintenance subcommand', async () => {
      const exitCode = await runPartition(['maintenance', '--help']);
      assert.strictEqual(exitCode, 0);
    });
  });

  describe('validation and error handling', () => {
    it('returns exit code 1 on unknown subcommand', async () => {
      const exitCode = await runPartition(['unknown_action']);
      assert.strictEqual(exitCode, 1);
    });

    it('returns exit code 1 when convert is missing flags', async () => {
      assert.strictEqual(await runPartition(['convert']), 1);
      assert.strictEqual(await runPartition(['convert', '--table', 'events']), 1);
    });

    it('returns exit code 1 when attach is missing flags', async () => {
      assert.strictEqual(await runPartition(['attach']), 1);
      assert.strictEqual(await runPartition(['attach', '--parent', 'events']), 1);
      assert.strictEqual(await runPartition(['attach', '--parent', 'events', '--partition', 'events_p1']), 1);
      assert.strictEqual(await runPartition(['attach', '--parent', 'events', '--partition', 'events_p1', '--from', '0']), 1);
    });

    it('returns exit code 1 when detach is missing flags', async () => {
      assert.strictEqual(await runPartition(['detach']), 1);
      assert.strictEqual(await runPartition(['detach', '--parent', 'events']), 1);
    });

    it('returns exit code 1 when maintenance is missing flags', async () => {
      assert.strictEqual(await runPartition(['maintenance']), 1);
    });
  });

  describe('successful executions', () => {
    it('generates partition convert SQL and exits 0', async () => {
      const exitCode = await runPartition(['convert', '--table', 'events', '--key', 'created_at', '--type', 'range']);
      assert.strictEqual(exitCode, 0);
    });

    it('generates partition attach SQL and exits 0', async () => {
      const exitCode = await runPartition([
        'attach',
        '--parent', 'events',
        '--partition', 'events_2026_10',
        '--from', '2026-10-01',
        '--to', '2026-11-01',
      ]);
      assert.strictEqual(exitCode, 0);
    });

    it('generates partition detach SQL and exits 0', async () => {
      const exitCode = await runPartition(['detach', '--parent', 'events', '--partition', 'events_2026_10']);
      assert.strictEqual(exitCode, 0);
    });

    it('generates partition maintenance SQL and exits 0', async () => {
      const exitCode = await runPartition(['maintenance', '--parent', 'events', '--interval', 'monthly']);
      assert.strictEqual(exitCode, 0);
    });

    it('dispatches cleanly via runCli("partition", "--help")', async () => {
      const exitCode = await runCli(['partition', '--help']);
      assert.strictEqual(exitCode, 0);
    });
  });
});

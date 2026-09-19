import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { parseDemoArgs, runDemo } from '../src/demo.js';
import { runCli } from '../src/cli.js';

describe('Interactive Terminal Demo (src/demo.ts)', () => {
  describe('parseDemoArgs', () => {
    it('parses --instant and -i flags', () => {
      assert.strictEqual(parseDemoArgs(['--instant']).instant, true);
      assert.strictEqual(parseDemoArgs(['-i']).instant, true);
      assert.strictEqual(parseDemoArgs([]).instant, false);
    });

    it('parses --help and -h flags', () => {
      assert.strictEqual(parseDemoArgs(['--help']).help, true);
      assert.strictEqual(parseDemoArgs(['-h']).help, true);
      assert.strictEqual(parseDemoArgs([]).help, false);
    });
  });

  describe('runDemo execution', () => {
    it('prints help and exits 0 on --help', async () => {
      let output = '';
      const origLog = console.log;
      console.log = (...args) => {
        output += args.join(' ') + '\n';
      };
      try {
        const code = await runDemo(['--help']);
        assert.strictEqual(code, 0);
        assert.ok(output.includes('ddlforge demo [options]'));
        assert.ok(output.includes('--instant'));
      } finally {
        console.log = origLog;
      }
    });

    it('executes full walkthrough with --instant and returns 0', async () => {
      let output = '';
      const origLog = console.log;
      console.log = (...args) => {
        output += args.join(' ') + '\n';
      };
      try {
        const code = await runDemo(['--instant']);
        assert.strictEqual(code, 0);
        assert.ok(output.includes('ddlforge v2.0.0'));
        assert.ok(output.includes('[SCENARIO 1/4] Migration Lock Avalanche & Autonomous Circuit Breaker'));
        assert.ok(output.includes('[SCENARIO 2/4] Zero-Downtime Statistical Bloat Estimator'));
        assert.ok(output.includes('[SCENARIO 3/4] Continuous WAL Archiving & Disaster Doctor'));
        assert.ok(output.includes('[SCENARIO 4/4] Zero-Data-Loss Blue/Green Migration Mesh'));
        assert.ok(output.includes('ZERO-DATA-LOSS CUTOVER COMPLETE'));
      } finally {
        console.log = origLog;
      }
    });

    it('dispatches demo subcommand via runCli', async () => {
      let output = '';
      const origLog = console.log;
      console.log = (...args) => {
        output += args.join(' ') + '\n';
      };
      try {
        const code = await runCli(['demo', '--instant']);
        assert.strictEqual(code, 0);
        assert.ok(output.includes('ddlforge v2.0.0'));
      } finally {
        console.log = origLog;
      }
    });
  });
});

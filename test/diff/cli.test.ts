/**
 * ddlforge — test/diff/cli.test.ts
 *
 * CLI command tests for `ddlforge diff` and `ddlforge lock`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runCli } from '../../src/cli.js';

describe('CLI: ddlforge diff and lock', () => {
  it('runs "ddlforge diff --help" and exits with 0', async () => {
    const originalLog = console.log;
    let output = '';
    console.log = (msg: string) => { output += msg + '\n'; };

    try {
      const code = await runCli(['diff', '--help']);
      assert.strictEqual(code, 0);
      assert.ok(output.includes('ddlforge diff'));
      assert.ok(output.includes('--db <url>'));
      assert.ok(output.includes('--format <type>'));
    } finally {
      console.log = originalLog;
    }
  });

  it('runs "ddlforge lock --help" and exits with 0', async () => {
    const originalLog = console.log;
    let output = '';
    console.log = (msg: string) => { output += msg + '\n'; };

    try {
      const code = await runCli(['lock', '--help']);
      assert.strictEqual(code, 0);
      assert.ok(output.includes('ddlforge lock'));
      assert.ok(output.includes('status'));
      assert.ok(output.includes('release'));
    } finally {
      console.log = originalLog;
    }
  });

  it('exits with error when "ddlforge diff" has no --db and no DATABASE_URL', async () => {
    const originalEnv = process.env['DATABASE_URL'];
    delete process.env['DATABASE_URL'];

    const originalError = console.error;
    let errOutput = '';
    console.error = (msg: string) => { errOutput += msg + '\n'; };

    try {
      const code = await runCli(['diff']);
      assert.strictEqual(code, 1);
      assert.ok(errOutput.includes('--db <url> is required'));
    } finally {
      console.error = originalError;
      if (originalEnv !== undefined) {
        process.env['DATABASE_URL'] = originalEnv;
      }
    }
  });

  it('exits with error when "ddlforge lock" has no --db and no DATABASE_URL', async () => {
    const originalEnv = process.env['DATABASE_URL'];
    delete process.env['DATABASE_URL'];

    const originalError = console.error;
    let errOutput = '';
    console.error = (msg: string) => { errOutput += msg + '\n'; };

    try {
      const code = await runCli(['lock', 'status']);
      assert.strictEqual(code, 1);
      assert.ok(errOutput.includes('--db <url> is required'));
    } finally {
      console.error = originalError;
      if (originalEnv !== undefined) {
        process.env['DATABASE_URL'] = originalEnv;
      }
    }
  });
});

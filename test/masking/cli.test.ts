/**
 * ddlforge — test/masking/cli.test.ts
 *
 * CLI command tests for `ddlforge mask`:
 *   - ddlforge mask --help
 *   - ddlforge mask trigger
 *   - ddlforge mask backfill
 *   - ddlforge mask advice
 *   - Error handling on missing arguments
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runCli } from '../../src/cli.js';

describe('CLI: ddlforge mask', () => {
  it('runs "ddlforge mask --help" and exits with 0', async () => {
    const originalLog = console.log;
    let output = '';
    console.log = (msg: string) => { output += msg + '\n'; };

    try {
      const code = await runCli(['mask', '--help']);
      assert.strictEqual(code, 0);
      assert.ok(output.includes('ddlforge mask'));
      assert.ok(output.includes('trigger'));
      assert.ok(output.includes('backfill'));
      assert.ok(output.includes('advice'));
    } finally {
      console.log = originalLog;
    }
  });

  it('runs "ddlforge mask trigger" with valid options', async () => {
    const originalLog = console.log;
    let output = '';
    console.log = (msg: string) => { output += msg + '\n'; };

    try {
      const code = await runCli(['mask', 'trigger', '--table', 'users', '--columns', 'email:email,id:integer']);
      assert.strictEqual(code, 0);
      assert.ok(output.includes('CREATE OR REPLACE TRIGGER "trg_mask_users"'));
      assert.ok(output.includes('_ddlforge_mask_email'));
      assert.ok(output.includes('feistel_encrypt_integer'));
    } finally {
      console.log = originalLog;
    }
  });

  it('runs "ddlforge mask backfill" with valid options', async () => {
    const originalLog = console.log;
    let output = '';
    console.log = (msg: string) => { output += msg + '\n'; };

    try {
      const code = await runCli(['mask', 'backfill', '--table', 'accounts', '--columns', 'uuid:uuid', '--pk', 'acc_id']);
      assert.strictEqual(code, 0);
      assert.ok(output.includes('CREATE OR REPLACE PROCEDURE "public"."sp_mask_backfill_accounts"'));
      assert.ok(output.includes('"acc_id" > v_last_id'));
    } finally {
      console.log = originalLog;
    }
  });

  it('runs "ddlforge mask advice" and emits advisory report', async () => {
    const originalLog = console.log;
    let output = '';
    console.log = (msg: string) => { output += msg + '\n'; };

    try {
      const code = await runCli(['mask', 'advice', '--table', 'orders', '--fillfactor', '80']);
      assert.strictEqual(code, 0);
      assert.ok(output.includes('Zero-Downtime Masking & Storage Advisory'));
      assert.ok(output.includes('fillfactor = 80'));
    } finally {
      console.log = originalLog;
    }
  });

  it('runs "ddlforge mask advice --format json" and emits valid JSON', async () => {
    const originalLog = console.log;
    let output = '';
    console.log = (msg: string) => { output += msg + '\n'; };

    try {
      const code = await runCli(['mask', 'advice', '--table', 'orders', '--format', 'json']);
      assert.strictEqual(code, 0);
      const parsed = JSON.parse(output);
      assert.strictEqual(parsed.table, 'orders');
      assert.ok(Array.isArray(parsed.items));
    } finally {
      console.log = originalLog;
    }
  });

  it('fails when --table is omitted', async () => {
    const originalError = console.error;
    let errOutput = '';
    console.error = (msg: string) => { errOutput += msg + '\n'; };

    try {
      const code = await runCli(['mask', 'trigger']);
      assert.strictEqual(code, 1);
      assert.ok(errOutput.includes('--table <table> flag is required'));
    } finally {
      console.error = originalError;
    }
  });

  it('fails when --columns is omitted for trigger', async () => {
    const originalError = console.error;
    let errOutput = '';
    console.error = (msg: string) => { errOutput += msg + '\n'; };

    try {
      const code = await runCli(['mask', 'trigger', '--table', 'users']);
      assert.strictEqual(code, 1);
      assert.ok(errOutput.includes('--columns <col:type,...> flag is required'));
    } finally {
      console.error = originalError;
    }
  });

  it('fails when --columns is omitted for backfill', async () => {
    const originalError = console.error;
    let errOutput = '';
    console.error = (msg: string) => { errOutput += msg + '\n'; };

    try {
      const code = await runCli(['mask', 'backfill', '--table', 'users']);
      assert.strictEqual(code, 1);
      assert.ok(errOutput.includes('--columns <col:type,...> flag is required'));
    } finally {
      console.error = originalError;
    }
  });
});

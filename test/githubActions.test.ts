/**
 * ddlforge — test/githubActions.test.ts
 *
 * Tests for native GitHub Actions PR workflow annotations and GITHUB_STEP_SUMMARY table.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { formatGithub, generateStepSummary, writeStepSummary } from '../src/reporters/github.js';
import { parseArgs, analyzeSql } from '../src/index.js';

describe('Native GitHub Actions PR Workflow Annotations', () => {
  it('detects --github-actions CLI flag and sets format to github', () => {
    const opts = parseArgs(['--github-actions']);
    assert.strictEqual(opts.githubActions, true);
    assert.strictEqual(opts.format, 'github');
  });

  it('auto-detects process.env.GITHUB_ACTIONS === "true"', () => {
    const prev = process.env.GITHUB_ACTIONS;
    try {
      process.env.GITHUB_ACTIONS = 'true';
      const opts = parseArgs([]);
      assert.strictEqual(opts.githubActions, true);
      assert.strictEqual(opts.format, 'github');
    } finally {
      if (prev !== undefined) {
        process.env.GITHUB_ACTIONS = prev;
      } else {
        delete process.env.GITHUB_ACTIONS;
      }
    }
  });

  it('formats failing findings with standard title "Dangerous Lock ({ruleId})"', () => {
    const sql = 'CREATE INDEX idx_users_email ON users (email);';
    const res = analyzeSql(sql, { filePath: 'db/migrations/20260927_idx.sql' });
    assert.strictEqual(res.hasBlockers, true);

    const output = formatGithub([res], { dangerousLockTitle: true });
    assert.ok(output.startsWith('::error '), `Expected ::error command, got:\n${output}`);
    assert.ok(output.includes('file=db/migrations/20260927_idx.sql'));
    assert.ok(output.includes('line=1'));
    assert.ok(output.includes('title=Dangerous Lock (require-concurrent-index)'));
    assert.ok(output.includes('::CREATE INDEX missing CONCURRENTLY keyword'));
  });

  it('generates a clean markdown summary table with the 6 required columns', () => {
    const sql = `
CREATE INDEX idx_users_email ON users (email);
ALTER TABLE orders ADD CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id);
    `;
    const res = analyzeSql(sql, { filePath: 'migrations/001_init.sql' });

    const summary = generateStepSummary([res]);
    assert.ok(summary.includes('### ddlforge Migration Safety Summary'));

    // Check header columns
    assert.ok(summary.includes('| File | Line | Statement | Lock Type | Downtime Risk | Recommended Fix |'));
    assert.ok(summary.includes('| --- | --- | --- | --- | --- | --- |'));

    // Check rows content
    assert.ok(summary.includes('migrations/001_init.sql'));
    assert.ok(summary.includes('SHARE'));
    assert.ok(summary.includes('High'));
    assert.ok(summary.includes('CONCURRENTLY'));
  });

  it('writes summary table to process.env.GITHUB_STEP_SUMMARY file path', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddlforge-summary-'));
    const summaryFile = path.join(tmpDir, 'step_summary.md');
    try {
      const sql = 'CREATE INDEX idx_audit ON audit_log (created_at);';
      const res = analyzeSql(sql, { filePath: 'migrations/audit.sql' });

      writeStepSummary(summaryFile, [res]);

      assert.ok(fs.existsSync(summaryFile), 'Summary file must exist');
      const content = fs.readFileSync(summaryFile, 'utf-8');
      assert.ok(content.includes('| File | Line | Statement | Lock Type | Downtime Risk | Recommended Fix |'));
      assert.ok(content.includes('migrations/audit.sql'));
      assert.ok(content.includes('SHARE'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('omits suppressed findings from workflow annotations and summary table', () => {
    const sql = `
-- ddlforge-disable-next-line require-concurrent-index reason="Index built in staging before load"
CREATE INDEX idx_users_email ON users (email);
    `;
    const res = analyzeSql(sql, { filePath: 'migrations/002_safe.sql' });
    assert.strictEqual(res.hasBlockers, false);

    const output = formatGithub([res], { dangerousLockTitle: true });
    assert.strictEqual(output, '', 'Suppressed findings must not produce ::error commands');

    const summary = generateStepSummary([res]);
    assert.ok(summary.includes('Zero dangerous locks detected'));
  });
});

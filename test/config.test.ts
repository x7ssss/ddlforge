/**
 * ddlforge — test/config.test.ts
 *
 * Tests for declarative configuration loader (.ddlforgerc.json and .ddlforge.json)
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { loadConfig, findConfigFile, matchesIgnorePattern, filterIgnoredFiles } from '../src/config.js';
import { parseArgs, discoverSqlFiles, analyzeSql, runCli } from '../src/index.js';

describe('Declarative Config Loader (.ddlforgerc.json or .ddlforge.json)', () => {
  it('discovers and loads .ddlforgerc.json in working directory', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddlforge-cfg-'));
    try {
      const configContent = {
        targetVersion: '16',
        rules: {
          'lock-access-exclusive': 'error',
          'non-concurrent-index': 'error',
          'unvalidated-foreign-key': 'error',
        },
        ignore: ['db/migrate/legacy/**'],
      };
      fs.writeFileSync(path.join(tmpDir, '.ddlforgerc.json'), JSON.stringify(configContent, null, 2), 'utf-8');

      const found = findConfigFile(tmpDir);
      assert.ok(found, 'Should find config file');
      assert.ok(found.endsWith('.ddlforgerc.json'));

      const { config, configPath } = loadConfig(tmpDir);
      assert.ok(config);
      assert.strictEqual(config?.targetVersion, '16');
      assert.strictEqual(config?.rules?.['lock-access-exclusive'], 'error');
      assert.strictEqual(config?.rules?.['non-concurrent-index'], 'error');
      assert.deepStrictEqual(config?.ignore, ['db/migrate/legacy/**']);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('falls back to .ddlforge.json if .ddlforgerc.json is absent', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddlforge-cfg2-'));
    try {
      fs.writeFileSync(
        path.join(tmpDir, '.ddlforge.json'),
        JSON.stringify({ targetVersion: 15 }, null, 2),
        'utf-8'
      );

      const found = findConfigFile(tmpDir);
      assert.ok(found);
      assert.ok(found.endsWith('.ddlforge.json'));

      const { config } = loadConfig(tmpDir);
      assert.strictEqual(config?.targetVersion, 15);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('matches ignore patterns accurately across relative and absolute paths', () => {
    const root = 'C:/repo/project';

    assert.ok(matchesIgnorePattern('C:/repo/project/db/migrate/legacy/001_old.sql', 'db/migrate/legacy/**', root));
    assert.ok(matchesIgnorePattern('db/migrate/legacy/sub/002_old.sql', 'db/migrate/legacy/**', root));
    assert.ok(!matchesIgnorePattern('C:/repo/project/db/migrate/active/003_new.sql', 'db/migrate/legacy/**', root));
    assert.ok(!matchesIgnorePattern('db/migrate/active/003_new.sql', 'db/migrate/legacy/**', root));

    // Wildcard filename
    assert.ok(matchesIgnorePattern('src/foo.test.sql', '*.test.sql', root));
    assert.ok(!matchesIgnorePattern('src/foo.sql', '*.test.sql', root));
  });

  it('filters ignored files during discoverSqlFiles', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddlforge-disc-'));
    try {
      const legacyDir = path.join(tmpDir, 'db', 'migrate', 'legacy');
      const activeDir = path.join(tmpDir, 'db', 'migrate', 'active');
      fs.mkdirSync(legacyDir, { recursive: true });
      fs.mkdirSync(activeDir, { recursive: true });

      const f1 = path.join(legacyDir, '001_legacy.sql');
      const f2 = path.join(activeDir, '002_active.sql');
      fs.writeFileSync(f1, 'SELECT 1;', 'utf-8');
      fs.writeFileSync(f2, 'SELECT 2;', 'utf-8');

      const discovered = discoverSqlFiles([tmpDir], false, tmpDir, ['db/migrate/legacy/**']);
      assert.strictEqual(discovered.length, 1);
      assert.ok(discovered[0].endsWith('002_active.sql'));
      assert.ok(!discovered.some(f => f.includes('legacy')));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('applies rule overrides from config (elevating warning to error and turning off rules)', () => {
    // drop-column-lock is normally WARNING
    const sql = 'ALTER TABLE users DROP COLUMN phone;';

    // Without override: WARNING
    const defaultRes = analyzeSql(sql);
    assert.strictEqual(defaultRes.warningsCount, 1);
    assert.strictEqual(defaultRes.blockersCount, 0);

    // With rule override to "error": elevates to BLOCKER
    const errorRes = analyzeSql(sql, {
      ruleConfig: { 'drop-column-lock': 'error' },
    });
    assert.strictEqual(errorRes.blockersCount, 1);
    assert.strictEqual(errorRes.warningsCount, 0);
    assert.strictEqual(errorRes.hasBlockers, true);

    // With lock-access-exclusive rule override to "error"
    const lockRes = analyzeSql(sql, {
      ruleConfig: { 'lock-access-exclusive': 'error' },
    });
    assert.strictEqual(lockRes.blockersCount, 1);
    assert.strictEqual(lockRes.hasBlockers, true);

    // With rule disabled ("off")
    const offRes = analyzeSql(sql, {
      ruleConfig: { 'drop-column-lock': 'off' },
    });
    assert.strictEqual(offRes.findings.length, 0);
    assert.strictEqual(offRes.hasBlockers, false);

    // With non-concurrent-index alias override to "off"
    const sqlIdx = 'CREATE INDEX idx_users ON users(name);';
    const offIdxRes = analyzeSql(sqlIdx, {
      ruleConfig: { 'non-concurrent-index': 'off' },
    });
    assert.strictEqual(offIdxRes.findings.length, 0);
  });

  it('merges config file targetVersion with CLI --pg argument override cleanly', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddlforge-cli-cfg-'));
    try {
      const configPath = path.join(tmpDir, '.ddlforgerc.json');
      fs.writeFileSync(
        configPath,
        JSON.stringify({ targetVersion: '14' }, null, 2),
        'utf-8'
      );

      const testSql = path.join(tmpDir, '001_test.sql');
      // In PG < 12, SET NOT NULL is BLOCKER; in PG >= 12, it's WARNING
      fs.writeFileSync(testSql, 'ALTER TABLE users ALTER COLUMN email SET NOT NULL;', 'utf-8');

      // 1. Without CLI --pg override: uses config targetVersion 14 (PG 14 -> WARNING, exit code 0)
      const codeDefault = await runCli(['--config', configPath, testSql]);
      assert.strictEqual(codeDefault, 0);

      // 2. With CLI --pg 11 override: overrides config (PG 11 -> BLOCKER, exit code 1)
      const codeOverride = await runCli(['--config', configPath, '--pg', '11', testSql]);
      assert.strictEqual(codeOverride, 1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

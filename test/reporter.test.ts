/**
 * ddlforge - Unit tests for reporters including SARIF 2.1.0
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { analyzeSql } from '../src/index.js';
import { formatSarif } from '../src/reporters/sarif.js';
import { ALL_RULES } from '../src/rules/index.js';

// ---------------------------------------------------------------------------
// SARIF Reporter: formatSarif()
// ---------------------------------------------------------------------------

describe('SARIF Reporter: formatSarif()', () => {
  it('produces valid JSON', () => {
    const result = analyzeSql('CREATE INDEX idx ON t(col);');
    const sarif = formatSarif([result]);
    assert.doesNotThrow(() => JSON.parse(sarif));
  });

  it('has correct $schema and version', () => {
    const sarif = JSON.parse(formatSarif([]));
    assert.strictEqual(
      sarif['$schema'],
      'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json',
    );
    assert.strictEqual(sarif.version, '2.1.0');
  });

  it('has a single run with tool.driver.name = "ddlforge"', () => {
    const sarif = JSON.parse(formatSarif([]));
    assert.ok(Array.isArray(sarif.runs));
    assert.strictEqual(sarif.runs.length, 1);
    assert.strictEqual(sarif.runs[0].tool.driver.name, 'ddlforge');
  });

  it('populates tool.driver.rules from ALL_RULES', () => {
    const sarif = JSON.parse(formatSarif([], ALL_RULES));
    const ruleIds = sarif.runs[0].tool.driver.rules.map((r: any) => r.id);
    assert.ok(ruleIds.includes('require-concurrent-index'));
    assert.ok(ruleIds.includes('check-constraint-not-valid'));
    assert.ok(ruleIds.includes('unique-constraint-using-index'));
    assert.ok(ruleIds.includes('session-advisory-lock'));
  });

  it('maps BLOCKER findings to level "error"', () => {
    const result = analyzeSql('CREATE INDEX idx ON t(col);');
    const sarif = JSON.parse(formatSarif([result]));
    const results = sarif.runs[0].results;
    assert.ok(results.length > 0);
    assert.strictEqual(results[0].level, 'error');
  });

  it('maps WARNING findings to level "warning"', () => {
    const result = analyzeSql('SELECT pg_advisory_lock(1);');
    const sarif = JSON.parse(formatSarif([result]));
    const results = sarif.runs[0].results;
    assert.ok(results.length > 0);
    const warningResult = results.find((r: any) => r.ruleId === 'session-advisory-lock');
    assert.ok(warningResult, 'should have a session-advisory-lock result');
    assert.strictEqual(warningResult.level, 'warning');
  });

  it('includes correct physicalLocation with startLine', () => {
    const result = analyzeSql('CREATE INDEX idx ON t(col);', { filePath: '/some/path/migration.sql' });
    const sarif = JSON.parse(formatSarif([result]));
    const firstResult = sarif.runs[0].results[0];
    assert.ok(firstResult.locations.length > 0);
    const loc = firstResult.locations[0].physicalLocation;
    assert.ok(loc.artifactLocation.uri.includes('migration.sql'));
    assert.ok(typeof loc.region.startLine === 'number');
  });

  it('returns empty results array when no findings', () => {
    const result = analyzeSql('CREATE INDEX CONCURRENTLY idx ON t(col);');
    const sarif = JSON.parse(formatSarif([result]));
    assert.strictEqual(sarif.runs[0].results.length, 0);
  });

  it('produces valid SARIF for empty results array', () => {
    const sarif = JSON.parse(formatSarif([]));
    assert.strictEqual(sarif.runs[0].results.length, 0);
    assert.ok(Array.isArray(sarif.runs[0].artifacts));
  });
});

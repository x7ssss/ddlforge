/**
 * ddlforge — test/reporters/github.test.ts
 *
 * Unit tests for the GitHub Actions workflow commands reporter.
 * Tests escape logic, severity routing, and empty-result handling.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatGithub } from '../../src/reporters/github.js';
import type { AnalysisResult } from '../../src/engine/analyzer.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResult(overrides: Partial<AnalysisResult> & { findings?: any[] }): AnalysisResult {
  return {
    file: 'migrations/001_test.sql',
    findings: [],
    statementsAnalyzed: 1,
    blockersCount: 0,
    warningsCount: 0,
    advisoriesCount: 0,
    hasBlockers: false,
    durationMs: 1,
    ...overrides,
  } as AnalysisResult;
}

function makeFinding(overrides: Record<string, any> = {}): any {
  return {
    ruleId: 'test-rule',
    ruleName: 'Test Rule',
    severity: 'BLOCKER',
    lockLevel: 'ACCESS_EXCLUSIVE',
    message: 'Unsafe operation detected',
    detail: 'This will lock the table',
    suggestion: 'Use CONCURRENTLY',
    file: 'migrations/001_test.sql',
    line: 5,
    column: 1,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('formatGithub', () => {
  it('returns empty string for no results', () => {
    const output = formatGithub([]);
    assert.strictEqual(output, '');
  });

  it('returns empty string for result with no findings', () => {
    const result = makeResult({ findings: [] });
    assert.strictEqual(formatGithub([result]), '');
  });

  it('formats a BLOCKER finding as ::error annotation', () => {
    const finding = makeFinding({ severity: 'BLOCKER', line: 10, column: 3 });
    const result = makeResult({ findings: [finding], blockersCount: 1, hasBlockers: true });
    const output = formatGithub([result]);

    assert.ok(output.startsWith('::error '), `Expected ::error, got: ${output}`);
    assert.ok(output.includes('file=migrations/001_test.sql'), 'Missing file prop');
    assert.ok(output.includes('line=10'), 'Missing line prop');
    assert.ok(output.includes('col=3'), 'Missing col prop');
    assert.ok(output.includes('title=ddlforge'), 'Missing title prop');
    assert.ok(output.includes('::Unsafe operation detected'), 'Missing message data');
  });

  it('formats a WARNING finding as ::warning annotation', () => {
    const finding = makeFinding({ severity: 'WARNING', line: 7, column: 1 });
    const result = makeResult({ findings: [finding], warningsCount: 1 });
    const output = formatGithub([result]);

    assert.ok(output.startsWith('::warning '), `Expected ::warning, got: ${output}`);
    assert.ok(output.includes('line=7'), 'Missing line prop');
  });

  it('does not emit ADVISORY findings by default', () => {
    const finding = makeFinding({ severity: 'ADVISORY' });
    const result = makeResult({ findings: [finding], advisoriesCount: 1 });
    const output = formatGithub([result]);

    assert.strictEqual(output, '', 'Expected empty string for ADVISORY with default options');
  });

  it('emits ADVISORY as ::notice when emitAdvisories is true', () => {
    const finding = makeFinding({ severity: 'ADVISORY' });
    const result = makeResult({ findings: [finding], advisoriesCount: 1 });
    const output = formatGithub([result], { emitAdvisories: true });

    assert.ok(output.startsWith('::notice '), `Expected ::notice, got: ${output}`);
  });

  it('emits multiple findings across multiple results in order', () => {
    const f1 = makeFinding({ severity: 'BLOCKER', message: 'First blocker', line: 1, file: 'a.sql' });
    const f2 = makeFinding({ severity: 'WARNING', message: 'Second warning', line: 2, file: 'b.sql' });
    const r1 = makeResult({ file: 'a.sql', findings: [f1], blockersCount: 1, hasBlockers: true });
    const r2 = makeResult({ file: 'b.sql', findings: [f2], warningsCount: 1 });

    const output = formatGithub([r1, r2]);
    const lines = output.split('\n');

    assert.strictEqual(lines.length, 2);
    assert.ok(lines[0].includes('::error'), 'First line should be ::error');
    assert.ok(lines[0].includes('First blocker'), 'First line should contain first message');
    assert.ok(lines[1].includes('::warning'), 'Second line should be ::warning');
    assert.ok(lines[1].includes('Second warning'), 'Second line should contain second message');
  });

  it('escapes colons and commas in file paths', () => {
    // Windows-style absolute paths have colons
    const finding = makeFinding({ file: 'C:/Users/dev/migrations/001.sql', severity: 'BLOCKER' });
    const result = makeResult({ findings: [finding], hasBlockers: true });
    const output = formatGithub([result]);

    // The colon in C: should be escaped to %3A and path separator colon must not break props
    assert.ok(!output.includes('file=C:/Users'), 'Drive letter colon must be escaped in property value');
    assert.ok(output.includes('%3A'), 'Expected %3A colon escape in file property');
  });

  it('escapes percent signs in messages', () => {
    const finding = makeFinding({ severity: 'BLOCKER', message: '100% lock risk' });
    const result = makeResult({ findings: [finding], hasBlockers: true });
    const output = formatGithub([result]);

    assert.ok(output.includes('%25'), 'Expected %25 escaped percent in message data');
    assert.ok(!output.includes('100% lock risk'), 'Raw percent must be escaped');
  });

  it('escapes newlines in messages', () => {
    const finding = makeFinding({ severity: 'BLOCKER', message: 'Line one\nLine two' });
    const result = makeResult({ findings: [finding], hasBlockers: true });
    const output = formatGithub([result]);

    assert.ok(output.includes('%0A'), 'Expected %0A escaped newline in message data');
  });

  it('uses result.file as fallback when finding.file is not set', () => {
    const finding = makeFinding({ severity: 'BLOCKER' });
    delete finding.file; // remove file from finding
    const result = makeResult({ file: 'fallback.sql', findings: [finding], hasBlockers: true });
    const output = formatGithub([result]);

    assert.ok(output.includes('file=fallback.sql'), 'Should use result.file as fallback');
  });

  it('defaults line and column to 1 when not present in finding', () => {
    const finding = makeFinding({ severity: 'BLOCKER' });
    delete finding.line;
    delete finding.column;
    const result = makeResult({ findings: [finding], hasBlockers: true });
    const output = formatGithub([result]);

    assert.ok(output.includes('line=1'), 'Should default line to 1');
    assert.ok(output.includes('col=1'), 'Should default col to 1');
  });

  it('produces lines without trailing whitespace', () => {
    const finding = makeFinding({ severity: 'BLOCKER' });
    const result = makeResult({ findings: [finding], hasBlockers: true });
    const output = formatGithub([result]);
    const lines = output.split('\n');

    for (const line of lines) {
      assert.strictEqual(line, line.trimEnd(), 'Line should not have trailing whitespace');
    }
  });

  it('handles mixed severity findings and emits in order', () => {
    const findings = [
      makeFinding({ severity: 'BLOCKER',  message: 'B1', line: 1 }),
      makeFinding({ severity: 'ADVISORY', message: 'A1', line: 2 }),
      makeFinding({ severity: 'WARNING',  message: 'W1', line: 3 }),
      makeFinding({ severity: 'BLOCKER',  message: 'B2', line: 4 }),
    ];
    const result = makeResult({ findings, blockersCount: 2, warningsCount: 1, advisoriesCount: 1, hasBlockers: true });
    const output = formatGithub([result]);
    const lines = output.split('\n');

    // ADVISORY is skipped by default, so we get 3 lines: B1, W1, B2
    assert.strictEqual(lines.length, 3);
    assert.ok(lines[0].includes('::error') && lines[0].includes('B1'));
    assert.ok(lines[1].includes('::warning') && lines[1].includes('W1'));
    assert.ok(lines[2].includes('::error') && lines[2].includes('B2'));
  });
});

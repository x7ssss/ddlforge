/**
 * ddlforge - Automated In-Place Fixer
 *
 * Automatically patches unsafe migration statements with non-blocking,
 * multi-phase zero-downtime remediation recipes.
 */

import { Finding } from '../rules/types.js';
import { Statement } from '../lexer/tokens.js';
import { splitStatements } from '../lexer/sqlTokenizer.js';

export interface FixResult {
  patchedSql: string;
  appliedCount: number;
  remainingBlockers: number;
  fixedRuleIds: string[];
}

/**
 * Computes a safe replacement for a finding if a known remediation recipe exists.
 */
export function getSafeReplacement(finding: Finding, stmt: Statement): string | null {
  // 1. If finding already provides an explicit multi-phase remediation recipe
  if (finding.remediation && finding.remediation.trim().length > 0) {
    return finding.remediation;
  }

  const raw = stmt.raw;

  // 2. require-concurrent-index: add CONCURRENTLY modifier
  if (finding.ruleId === 'require-concurrent-index') {
    if (/^CREATE\s+UNIQUE\s+INDEX\b/i.test(raw)) {
      return raw.replace(/^CREATE\s+UNIQUE\s+INDEX\b/i, 'CREATE UNIQUE INDEX CONCURRENTLY') + ';';
    }
    if (/^CREATE\s+INDEX\b/i.test(raw)) {
      return raw.replace(/^CREATE\s+INDEX\b/i, 'CREATE INDEX CONCURRENTLY') + ';';
    }
  }

  // 3. reindex-missing-concurrently: add CONCURRENTLY
  if (finding.ruleId === 'reindex-missing-concurrently') {
    if (/^REINDEX\s+(TABLE|INDEX|SCHEMA)\b/i.test(raw)) {
      return raw.replace(/^REINDEX\s+(TABLE|INDEX|SCHEMA)\b/i, 'REINDEX $1 CONCURRENTLY') + ';';
    }
  }

  // 4. detach-partition-non-concurrent: add CONCURRENTLY
  if (finding.ruleId === 'detach-partition-non-concurrent') {
    if (/DETACH\s+PARTITION\s+([a-zA-Z0-9_."]+)/i.test(raw)) {
      return raw.replace(/DETACH\s+PARTITION\s+([a-zA-Z0-9_."]+)/i, 'DETACH PARTITION $1 CONCURRENTLY') + ';';
    }
  }

  // 5. check-constraint-missing-not-valid: add NOT VALID + VALIDATE CONSTRAINT
  if (finding.ruleId === 'check-constraint-missing-not-valid' || finding.ruleId === 'check-constraint-not-valid') {
    // Check if ALTER TABLE <table> ADD [CONSTRAINT <name>] CHECK (...)
    const m = raw.match(/ALTER\s+TABLE\s+(?:ONLY\s+|IF\s+EXISTS\s+)*([^\s;]+)\s+ADD\s+(?:CONSTRAINT\s+([^\s;]+)\s+)?CHECK\s*(\([^;]+\))/i);
    if (m) {
      const table = m[1];
      const cname = m[2] || `chk_${table.replace(/["`]/g, '')}_${Date.now()}`;
      const expr = m[3];
      return `-- 2-phase check constraint addition (safe, non-blocking)
ALTER TABLE ${table} ADD CONSTRAINT ${cname} CHECK ${expr} NOT VALID;
ALTER TABLE ${table} VALIDATE CONSTRAINT ${cname};`;
    }
  }

  return null;
}

/**
 * Applies automated safe fixes to SQL content for all fixable blocker findings.
 */
export function applyFixes(sql: string, findings: Finding[]): FixResult {
  const blockers = findings.filter(f => f.severity === 'BLOCKER');
  if (blockers.length === 0) {
    return {
      patchedSql: sql,
      appliedCount: 0,
      remainingBlockers: 0,
      fixedRuleIds: [],
    };
  }

  const statements = splitStatements(sql);
  const fixedRuleIds: string[] = [];

  // Map statements to fixes
  interface ReplacementSpan {
    start: number;
    end: number;
    replacement: string;
    ruleId: string;
  }

  const replacements: ReplacementSpan[] = [];

  for (const blocker of blockers) {
    // Find the statement matching this finding
    const matchingStmt = statements.find(s =>
      s.startLine === blocker.line ||
      (s.tokens.length > 0 && s.raw.includes(blocker.codeSnippet.trim())) ||
      (s.startOffset <= blocker.column && s.endOffset >= blocker.column)
    ) ?? statements.find(s => s.raw.trim() === blocker.codeSnippet.trim());

    if (!matchingStmt) continue;

    const safeSql = getSafeReplacement(blocker, matchingStmt);
    if (safeSql) {
      replacements.push({
        start: matchingStmt.startOffset,
        end: matchingStmt.endOffset,
        replacement: safeSql,
        ruleId: blocker.ruleId,
      });
      fixedRuleIds.push(blocker.ruleId);
    }
  }

  if (replacements.length === 0) {
    return {
      patchedSql: sql,
      appliedCount: 0,
      remainingBlockers: blockers.length,
      fixedRuleIds: [],
    };
  }

  // Sort replacements backwards (descending start offset) to avoid offset drift
  replacements.sort((a, b) => b.start - a.start);

  // Remove overlapping replacements if any
  const deduplicated: ReplacementSpan[] = [];
  let lastStart = Infinity;
  for (const r of replacements) {
    if (r.end <= lastStart) {
      deduplicated.push(r);
      lastStart = r.start;
    }
  }

  let patched = sql;
  for (const r of deduplicated) {
    patched = patched.slice(0, r.start) + r.replacement + patched.slice(r.end);
  }

  return {
    patchedSql: patched,
    appliedCount: deduplicated.length,
    remainingBlockers: blockers.length - deduplicated.length,
    fixedRuleIds,
  };
}

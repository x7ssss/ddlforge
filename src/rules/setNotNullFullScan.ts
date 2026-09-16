/**
 * ddlforge Rule: ALTER COLUMN SET NOT NULL Full Scan Lock
 *
 * Severity: WARNING (or BLOCKER for PG < 12)
 * Lock: ACCESS EXCLUSIVE
 */

import { Rule, RuleContext, Finding, Severity } from './types.js';
import { PostgresLockLevel } from '../engine/locks.js';
import { Token } from '../lexer/tokens.js';

function extractSetNotNullClauses(tokens: Token[]): Array<{ columnName: string }> {
  const results: Array<{ columnName: string }> = [];
  let parenDepth = 0;
  let i = 0;

  while (i < tokens.length) {
    if (tokens[i].value === '(') {
      parenDepth++;
      i++;
      continue;
    }
    if (tokens[i].value === ')') {
      parenDepth--;
      i++;
      continue;
    }

    if (parenDepth === 0 && tokens[i].value === 'ALTER') {
      let currentIdx = i + 1;
      if (tokens[currentIdx]?.value === 'COLUMN') currentIdx++;

      const columnName = tokens[currentIdx]?.raw;
      currentIdx++;

      if (tokens[currentIdx]?.value === 'SET' && tokens[currentIdx + 1]?.value === 'NOT' && tokens[currentIdx + 2]?.value === 'NULL') {
        if (columnName) {
          results.push({ columnName });
        }
        i = currentIdx + 3;
        continue;
      }
    }

    i++;
  }

  return results;
}

export const setNotNullFullScanRule: Rule = {
  id: 'set-not-null-full-scan',
  name: 'ALTER COLUMN SET NOT NULL Full Scan Lock',
  description: 'ALTER COLUMN SET NOT NULL scans the entire table under an ACCESS EXCLUSIVE lock to verify non-nullability.',
  defaultSeverity: 'WARNING',
  lockLevel: PostgresLockLevel.ACCESS_EXCLUSIVE,

  check(context: RuleContext): Finding[] {
    const findings: Finding[] = [];
    const severity: Severity = context.pgVersion < 12 ? 'BLOCKER' : this.defaultSeverity;

    for (const stmt of context.statements) {
      if (stmt.hasIgnore(this.id)) continue;

      const tokens = stmt.tokens;
      if (tokens.length < 6) continue;

      if (tokens[0].value !== 'ALTER' || tokens[1].value !== 'TABLE') continue;

      let idx = 2;
      if (tokens[idx]?.value === 'ONLY') idx++;
      if (tokens[idx]?.value === 'IF' && tokens[idx + 1]?.value === 'EXISTS') idx += 2;
      const tableName = tokens[idx]?.raw ?? 'table';
      idx++;

      // Scan subcommands
      const targets = extractSetNotNullClauses(tokens.slice(idx));

      for (const target of targets) {
        findings.push({
          ruleId: this.id,
          ruleName: this.name,
          severity,
          lockLevel: this.lockLevel,
          message: `Direct ALTER COLUMN "${target.columnName}" SET NOT NULL on table "${tableName}".`,
          detail:
            `Setting NOT NULL directly forces a full table scan while holding an ACCESS EXCLUSIVE lock. ` +
            `This blocks all reads and writes to "${tableName}" for the duration of the scan.`,
          suggestion:
            `Safe zero-downtime 3-step pattern:\n` +
            `   1. Add check constraint NOT VALID:\n` +
            `      ALTER TABLE ${tableName} ADD CONSTRAINT chk_${target.columnName}_not_null CHECK (${target.columnName} IS NOT NULL) NOT VALID;\n` +
            `   2. Validate constraint without blocking writes:\n` +
            `      ALTER TABLE ${tableName} VALIDATE CONSTRAINT chk_${target.columnName}_not_null;\n` +
            `   3. Apply SET NOT NULL (instant in PG 12+ due to validated constraint):\n` +
            `      ALTER TABLE ${tableName} ALTER COLUMN ${target.columnName} SET NOT NULL;`,
          file: context.filePath,
          line: stmt.startLine,
          column: stmt.startColumn,
          codeSnippet: stmt.raw,
        });
      }
    }

    return findings;
  },
};

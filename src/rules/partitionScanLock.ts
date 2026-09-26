/**
 * ddlforge Rule: ATTACH PARTITION without pre-validated CHECK constraint
 *
 * Rule ID: partition-scan-lock
 * Severity: BLOCKER
 * Lock: ACCESS EXCLUSIVE
 *
 * Attaching a partition without a pre-validated CHECK constraint forces
 * PostgreSQL to perform a full sequential scan of the partition under
 * an ACCESS EXCLUSIVE lock to verify all rows satisfy the partition bounds.
 */

import { Rule, RuleContext, Finding } from './types.js';
import { PostgresLockLevel } from '../engine/locks.js';

function normalizeName(raw: string): string {
  return raw.toLowerCase().replace(/^"|"$/g, '').replace(/^'|'$/g, '');
}

function hasPreValidatedCheck(
  statements: Array<{ tokens: Array<{ value: string; raw: string }>; startLine: number }>,
  currentIndex: number,
  partitionName: string
): boolean {
  const normPartition = normalizeName(partitionName);
  const validated = new Set<string>();

  for (let i = 0; i < currentIndex; i++) {
    const tokens = statements[i].tokens;
    if (tokens.length < 3) continue;

    if (tokens[0].value !== 'ALTER' || tokens[1].value !== 'TABLE') continue;

    let idx = 2;
    while (idx < tokens.length) {
      if (tokens[idx]?.value === 'IF' && tokens[idx + 1]?.value === 'EXISTS') { idx += 2; continue; }
      if (tokens[idx]?.value === 'ONLY') { idx++; continue; }
      break;
    }
    const tableParts: string[] = [tokens[idx]?.raw ?? ''];
    idx++;
    while (idx < tokens.length && tokens[idx]?.value === '.') {
      tableParts.push('.'); idx++;
      if (idx < tokens.length) { tableParts.push(tokens[idx].raw); idx++; }
    }
    const tbl = normalizeName(tableParts.join(''));

    if (tbl !== normPartition) continue;

    for (let j = idx; j < tokens.length; j++) {
      if (tokens[j]?.value === 'VALIDATE' && tokens[j + 1]?.value === 'CONSTRAINT') {
        const cname = normalizeName(tokens[j + 2]?.raw ?? '');
        validated.add(`${tbl}.${cname}`);
        validated.add(`${tbl}.*`);
      }
    }
  }

  if (validated.has(`${normPartition}.*`)) return true;
  for (const key of validated) {
    if (key.startsWith(`${normPartition}.`)) return true;
  }
  return false;
}

export const partitionScanLockRule: Rule = {
  id: 'partition-scan-lock',
  name: 'ATTACH PARTITION without pre-validated CHECK constraint',
  description:
    'Attaching a partition without a pre-validated CHECK constraint forces a full table scan under ACCESS EXCLUSIVE lock.',
  defaultSeverity: 'BLOCKER',
  lockLevel: PostgresLockLevel.ACCESS_EXCLUSIVE,

  check(context: RuleContext): Finding[] {
    const findings: Finding[] = [];

    for (let stmtIdx = 0; stmtIdx < context.statements.length; stmtIdx++) {
      const stmt = context.statements[stmtIdx];
      if (stmt.hasIgnore(this.id)) continue;

      const tokens = stmt.tokens;
      if (tokens.length < 6) continue;

      if (tokens[0].value !== 'ALTER' || tokens[1].value !== 'TABLE') continue;

      let idx = 2;
      while (idx < tokens.length) {
        if (tokens[idx]?.value === 'IF' && tokens[idx + 1]?.value === 'EXISTS') { idx += 2; continue; }
        if (tokens[idx]?.value === 'ONLY') { idx++; continue; }
        break;
      }

      const parentParts: string[] = [];
      if (idx < tokens.length) {
        parentParts.push(tokens[idx].raw);
        idx++;
        while (idx < tokens.length && tokens[idx]?.value === '.') {
          parentParts.push('.'); idx++;
          if (idx < tokens.length) { parentParts.push(tokens[idx].raw); idx++; }
        }
      }
      const parentTable = parentParts.join('') || 'table';

      while (idx < tokens.length) {
        if (tokens[idx]?.value === 'ATTACH' && tokens[idx + 1]?.value === 'PARTITION') {
          idx += 2;
          if (tokens[idx]?.value === 'IF' && tokens[idx + 1]?.value === 'NOT' && tokens[idx + 2]?.value === 'EXISTS') {
            idx += 3;
          }
          const partitionName = tokens[idx]?.raw ?? '<partition>';

          if (!hasPreValidatedCheck(context.statements, stmtIdx, partitionName)) {
            findings.push({
              ruleId: this.id,
              ruleName: this.name,
              severity: this.defaultSeverity,
              lockLevel: this.lockLevel,
              message:
                `ATTACH PARTITION "${partitionName}" to "${parentTable}" without a pre-validated CHECK constraint.`,
              detail:
                `Without a pre-validated CHECK constraint covering partition bounds, PostgreSQL scans the entire partition under ACCESS EXCLUSIVE lock, blocking reads and writes.`,
              suggestion:
                `1. Add NOT VALID CHECK constraint on partition: ALTER TABLE ${partitionName} ADD CONSTRAINT chk_bounds CHECK (...) NOT VALID;\n` +
                `2. Validate constraint: ALTER TABLE ${partitionName} VALIDATE CONSTRAINT chk_bounds;\n` +
                `3. Attach partition: ALTER TABLE ${parentTable} ATTACH PARTITION ${partitionName} ...;\n` +
                `4. Drop constraint: ALTER TABLE ${partitionName} DROP CONSTRAINT chk_bounds;`,
              file: context.filePath,
              line: stmt.startLine,
              column: stmt.startColumn,
              codeSnippet: stmt.raw,
            });
          }
          break;
        }
        idx++;
      }
    }

    return findings;
  },
};

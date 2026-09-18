/**
 * ddlforge Rule: ATTACH PARTITION without pre-validated CHECK constraint
 *
 * Rule ID: attach-partition-missing-check
 * Severity: BLOCKER
 * Lock: ACCESS EXCLUSIVE (ShareUpdateExclusiveLock + sequential scan)
 *
 * Fires when ALTER TABLE ... ATTACH PARTITION is detected without evidence of a
 * pre-validated CHECK constraint covering the partition bounds in an earlier
 * statement in the same file/migration.
 *
 * Safe pattern (4-phase):
 *   1. ALTER TABLE <partition> ADD CONSTRAINT <name> CHECK (...) NOT VALID;
 *   2. ALTER TABLE <partition> VALIDATE CONSTRAINT <name>;
 *   3. ALTER TABLE <parent> ATTACH PARTITION <partition> FOR VALUES ...;
 *   4. ALTER TABLE <partition> DROP CONSTRAINT <name>;
 */

import { Rule, RuleContext, Finding } from './types.js';
import { PostgresLockLevel } from '../engine/locks.js';

/**
 * Returns the normalized (lower-case, unquoted) table name from a token raw.
 */
function normalizeName(raw: string): string {
  return raw.toLowerCase().replace(/^"|"$/g, '').replace(/^'|'$/g, '');
}

/**
 * Scan earlier statements and return true if the partition table had a
 * NOT VALID CHECK constraint that was subsequently VALIDATED before this
 * ATTACH statement.
 *
 * We track two signals:
 *   - addedNotValidConstraints: Set of "<table>.<constraintName>"
 *   - validatedConstraints:     Set of "<table>.<constraintName>"
 *
 * If there is at least one validated check constraint on the partition before
 * the ATTACH, we treat it as safe.
 */
function hasPreValidatedCheck(
  statements: Array<{ tokens: Array<{ value: string; raw: string }>; startLine: number }>,
  currentIndex: number,
  partitionName: string,
): boolean {
  const normPartition = normalizeName(partitionName);

  const addedNotValid = new Set<string>();
  const validated = new Set<string>();

  for (let i = 0; i < currentIndex; i++) {
    const tokens = statements[i].tokens;
    if (tokens.length < 3) continue;

    if (tokens[0].value !== 'ALTER' || tokens[1].value !== 'TABLE') continue;

    // Extract table name (skip IF EXISTS / ONLY)
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

    // Scan for VALIDATE CONSTRAINT <name>  or ADD CONSTRAINT ... CHECK ... NOT VALID
    for (let j = idx; j < tokens.length; j++) {
      // VALIDATE CONSTRAINT <name>
      if (tokens[j]?.value === 'VALIDATE' && tokens[j + 1]?.value === 'CONSTRAINT') {
        const cname = normalizeName(tokens[j + 2]?.raw ?? '');
        const key = `${tbl}.${cname}`;
        validated.add(key);
        // Also track generically that this table had a validate
        validated.add(`${tbl}.*`);
      }

      // ADD [CONSTRAINT <name>] CHECK ... NOT VALID
      if (tokens[j]?.value === 'ADD') {
        let k = j + 1;
        let constraintName = '*';
        if (tokens[k]?.value === 'CONSTRAINT') {
          k++;
          constraintName = normalizeName(tokens[k]?.raw ?? '*');
          k++;
        }
        // Find CHECK keyword
        while (k < tokens.length && tokens[k]?.value !== 'CHECK') k++;
        if (tokens[k]?.value === 'CHECK') {
          // Look for NOT VALID after the check expression (skip parens)
          let depth = 0;
          k++;
          while (k < tokens.length) {
            if (tokens[k].value === '(') depth++;
            if (tokens[k].value === ')') depth--;
            if (depth === 0 && tokens[k].value === 'NOT' && tokens[k + 1]?.value === 'VALID') {
              addedNotValid.add(`${tbl}.${constraintName}`);
              break;
            }
            if (depth < 0) break;
            k++;
          }
        }
      }
    }
  }

  // We consider it safe if there's a validated constraint on the partition.
  // Either a specific constraint was validated, or a generic validate happened.
  if (validated.has(`${normPartition}.*`)) return true;
  for (const key of validated) {
    if (key.startsWith(`${normPartition}.`)) return true;
  }
  return false;
}

export const attachPartitionMissingCheckRule: Rule = {
  id: 'attach-partition-missing-check',
  name: 'ATTACH PARTITION without pre-validated CHECK constraint',
  description:
    'Attaching a partition without a pre-validated CHECK constraint forces PostgreSQL to perform a ' +
    'synchronous full sequential scan of the entire partition under AccessExclusiveLock, ' +
    'blocking all reads and writes on both tables for the duration of the scan.',
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

      // Skip modifiers before table name
      let idx = 2;
      while (idx < tokens.length) {
        if (tokens[idx]?.value === 'IF' && tokens[idx + 1]?.value === 'EXISTS') { idx += 2; continue; }
        if (tokens[idx]?.value === 'ONLY') { idx++; continue; }
        break;
      }

      // Collect parent table name
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

      // Scan for ATTACH PARTITION <partition_name>
      while (idx < tokens.length) {
        if (tokens[idx]?.value === 'ATTACH' && tokens[idx + 1]?.value === 'PARTITION') {
          idx += 2;
          // Skip optional IF NOT EXISTS
          if (tokens[idx]?.value === 'IF' && tokens[idx + 1]?.value === 'NOT' && tokens[idx + 2]?.value === 'EXISTS') {
            idx += 3;
          }
          const partitionName = tokens[idx]?.raw ?? '<partition>';

          // Check if there's a pre-validated constraint on the partition
          if (!hasPreValidatedCheck(context.statements, stmtIdx, partitionName)) {
            findings.push({
              ruleId: this.id,
              ruleName: this.name,
              severity: this.defaultSeverity,
              lockLevel: this.lockLevel,
              message:
                `ATTACH PARTITION "${partitionName}" to "${parentTable}" without a pre-validated CHECK constraint.`,
              detail:
                `Without a pre-validated CHECK constraint matching the partition bounds, PostgreSQL must ` +
                `perform a full sequential scan of "${partitionName}" under AccessExclusiveLock to verify ` +
                `all existing rows satisfy the partition constraint. This blocks all reads and writes on ` +
                `both "${parentTable}" and "${partitionName}" for the entire duration.`,
              suggestion:
                `Use the 4-phase attach pattern:\n` +
                `  1. Add a NOT VALID check covering the partition bounds:\n` +
                `     ALTER TABLE ${partitionName} ADD CONSTRAINT chk_partition_bounds CHECK (<bounds_expr>) NOT VALID;\n` +
                `  2. Validate asynchronously (SHARE UPDATE EXCLUSIVE, non-blocking reads/writes):\n` +
                `     ALTER TABLE ${partitionName} VALIDATE CONSTRAINT chk_partition_bounds;\n` +
                `  3. Attach the partition (scan skipped — constraint already verified):\n` +
                `     ALTER TABLE ${parentTable} ATTACH PARTITION ${partitionName} FOR VALUES ...;\n` +
                `  4. Drop the temporary constraint:\n` +
                `     ALTER TABLE ${partitionName} DROP CONSTRAINT chk_partition_bounds;`,
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

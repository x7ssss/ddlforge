/**
 * ddlforge Rule: DROP COLUMN acquires ACCESS EXCLUSIVE lock
 *
 * Severity: WARNING
 * Lock: ACCESS EXCLUSIVE
 *
 * Fires whenever ALTER TABLE ... DROP COLUMN is detected.  Although PostgreSQL
 * implements DROP COLUMN as a metadata-only operation (data remains until
 * VACUUM), the ACCESS EXCLUSIVE lock still blocks all concurrent reads and
 * writes for the duration of the command.
 */

import { Rule, RuleContext, Finding } from './types.js';
import { PostgresLockLevel } from '../engine/locks.js';
import { Token } from '../lexer/tokens.js';

interface DropColumnClause {
  colName: string;
}

/**
 * Scan tokens (after the table name) for every DROP COLUMN sub-command.
 */
function extractDropColumnClauses(tokens: Token[]): DropColumnClause[] {
  const clauses: DropColumnClause[] = [];
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

    if (parenDepth === 0 && tokens[i].value === 'DROP') {
      let cur = i + 1;

      // Require the next keyword to be COLUMN
      if (tokens[cur]?.value !== 'COLUMN') {
        i++;
        continue;
      }
      cur++;

      // Skip optional IF EXISTS on the column
      if (tokens[cur]?.value === 'IF' && tokens[cur + 1]?.value === 'EXISTS') cur += 2;

      const colName = tokens[cur]?.raw;
      if (colName) {
        clauses.push({ colName });
      }

      i = cur + 1;
      continue;
    }

    i++;
  }

  return clauses;
}

export const dropColumnLockRule: Rule = {
  id: 'drop-column-lock',
  name: 'DROP COLUMN acquires ACCESS EXCLUSIVE lock',
  description:
    'DROP COLUMN acquires ACCESS EXCLUSIVE lock on the table, blocking all concurrent reads and writes for the duration of the operation.',
  defaultSeverity: 'WARNING',
  lockLevel: PostgresLockLevel.ACCESS_EXCLUSIVE,

  check(context: RuleContext): Finding[] {
    const findings: Finding[] = [];

    for (const stmt of context.statements) {
      if (stmt.hasIgnore(this.id)) continue;

      const tokens = stmt.tokens;
      if (tokens.length < 5) continue;

      if (tokens[0].value !== 'ALTER' || tokens[1].value !== 'TABLE') continue;

      // Extract table name, honouring IF EXISTS and ONLY modifiers
      let idx = 2;
      if (tokens[idx]?.value === 'ONLY') idx++;
      if (tokens[idx]?.value === 'IF' && tokens[idx + 1]?.value === 'EXISTS') idx += 2;
      const tableName = tokens[idx]?.raw ?? 'table';
      idx++;

      const clauses = extractDropColumnClauses(tokens.slice(idx));

      for (const clause of clauses) {
        findings.push({
          ruleId: this.id,
          ruleName: this.name,
          severity: this.defaultSeverity,
          lockLevel: this.lockLevel,
          message: `Dropping column "${clause.colName}" from table "${tableName}" requires ACCESS EXCLUSIVE lock.`,
          detail:
            `DROP COLUMN acquires ACCESS EXCLUSIVE lock on the table, blocking all concurrent reads and writes ` +
            `for the duration of the operation. In PostgreSQL, DROP COLUMN is a metadata-only operation ` +
            `(the data remains until VACUUM) but the lock is still exclusive.`,
          suggestion:
            `1. Ensure application code no longer reads or writes the column before dropping it.\n` +
            `2. Deploy the code change first, then run the DROP COLUMN in a maintenance window or low-traffic period.\n` +
            `3. Consider using a phased approach:\n` +
            `   a. Rename the column (less disruptive but still locks): ALTER TABLE ${tableName} RENAME COLUMN ${clause.colName} TO ${clause.colName}_deprecated;\n` +
            `   b. Drop it in a separate deploy after verification.`,
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

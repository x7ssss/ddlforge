/**
 * ddlforge Rule: PRIMARY KEY USING INDEX on nullable column without prior validated NOT NULL
 *
 * Severity: WARNING
 * Lock: ACCESS EXCLUSIVE
 *
 * When attaching an existing unique index as a PRIMARY KEY constraint using
 * `ADD PRIMARY KEY USING INDEX`, PostgreSQL must still verify that the indexed
 * column(s) do not contain NULLs. If the column was not already marked NOT NULL
 * via prior validation, PostgreSQL performs a full table scan while holding
 * an ACCESS EXCLUSIVE lock.
 */

import { Rule, RuleContext, Finding } from './types.js';
import { PostgresLockLevel } from '../engine/locks.js';
import { cleanIdentifier } from '../engine/remediation.js';

function hasPriorNotNull(
  statements: Array<{ raw: string }>,
  currentIndex: number,
  tableName: string
): boolean {
  const normTable = tableName.toLowerCase();
  for (let i = 0; i < currentIndex; i++) {
    const raw = statements[i].raw.toLowerCase();
    if (raw.includes(normTable)) {
      if (raw.includes('set not null') || (raw.includes('is not null') && raw.includes('validate constraint'))) {
        return true;
      }
    }
  }
  return false;
}

export const primaryKeyUsingIndexNullableRule: Rule = {
  id: 'primary-key-using-index-nullable-column',
  name: 'PRIMARY KEY USING INDEX on nullable column without prior validated NOT NULL',
  description:
    'Attaching a unique index as PRIMARY KEY will still trigger a full table scan under ACCESS EXCLUSIVE lock if columns are not already marked NOT NULL.',
  defaultSeverity: 'WARNING',
  lockLevel: PostgresLockLevel.ACCESS_EXCLUSIVE,

  check(context: RuleContext): Finding[] {
    const findings: Finding[] = [];

    for (let stmtIdx = 0; stmtIdx < context.statements.length; stmtIdx++) {
      const stmt = context.statements[stmtIdx];
      if (stmt.hasIgnore(this.id)) continue;

      const raw = stmt.raw;
      const m = /ALTER\s+TABLE\s+(?:ONLY\s+|IF\s+EXISTS\s+)*([^\s;]+)\s+ADD\s+(?:CONSTRAINT\s+([^\s;]+)\s+)?PRIMARY\s+KEY\s+USING\s+INDEX\s+([^\s;]+)/i.exec(raw);
      if (!m) continue;

      const tableName = cleanIdentifier(m[1]);
      const indexName = cleanIdentifier(m[3]);

      if (!hasPriorNotNull(context.statements, stmtIdx, tableName)) {
        findings.push({
          ruleId: this.id,
          ruleName: this.name,
          severity: this.defaultSeverity,
          lockLevel: this.lockLevel,
          message: `PRIMARY KEY USING INDEX "${indexName}" on table "${tableName}" may trigger full table scan if column is nullable.`,
          detail:
            `PostgreSQL enforces NOT NULL on all PRIMARY KEY columns. If the columns in index "${indexName}" ` +
            `are not already NOT NULL, PostgreSQL acquires an ACCESS EXCLUSIVE lock and scans the table to verify non-nullability.`,
          suggestion:
            `Ensure the column is verified NOT NULL using the zero-downtime 3-step pattern before attaching the index:\n` +
            `  1. ALTER TABLE ${tableName} ADD CONSTRAINT chk_not_null CHECK (<col> IS NOT NULL) NOT VALID;\n` +
            `  2. ALTER TABLE ${tableName} VALIDATE CONSTRAINT chk_not_null;\n` +
            `  3. ALTER TABLE ${tableName} ALTER COLUMN <col> SET NOT NULL;`,
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

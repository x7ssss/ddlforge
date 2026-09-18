/**
 * ddlforge Rule: ADD CONSTRAINT CHECK without NOT VALID
 *
 * Rule ID: check-constraint-missing-not-valid
 * Severity: BLOCKER
 * Lock: ACCESS EXCLUSIVE
 */

import { Rule, RuleContext, Finding } from './types.js';
import { PostgresLockLevel } from '../engine/locks.js';
import { Token } from '../lexer/tokens.js';

interface CheckConstraintClause {
  constraintName?: string;
  hasNotValid: boolean;
  tokens: Token[];
}

function extractCheckConstraintClauses(tokens: Token[]): CheckConstraintClause[] {
  const clauses: CheckConstraintClause[] = [];
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

    if (parenDepth === 0 && tokens[i].value === 'ADD') {
      let currentIdx = i + 1;
      let constraintName: string | undefined;

      if (tokens[currentIdx]?.value === 'CONSTRAINT') {
        currentIdx++;
        constraintName = tokens[currentIdx]?.raw;
        currentIdx++;
      }

      // Check if this clause is a CHECK constraint
      if (tokens[currentIdx]?.value === 'CHECK') {
        const clauseTokens: Token[] = [];
        let hasNotValid = false;
        let subParen = 0;

        while (currentIdx < tokens.length) {
          const t = tokens[currentIdx];
          if (t.value === '(') subParen++;
          if (t.value === ')') subParen--;

          if (subParen === 0 && t.value === ',') {
            break;
          }

          clauseTokens.push(t);

          if (t.value === 'NOT' && tokens[currentIdx + 1]?.value === 'VALID') {
            hasNotValid = true;
          }

          currentIdx++;
        }

        clauses.push({
          constraintName,
          hasNotValid,
          tokens: clauseTokens,
        });

        i = currentIdx;
        continue;
      }
    }

    i++;
  }

  return clauses;
}

export const checkConstraintMissingNotValidRule: Rule = {
  id: 'check-constraint-missing-not-valid',
  name: 'ADD CONSTRAINT CHECK without NOT VALID',
  description:
    'Adding a CHECK constraint without NOT VALID performs an immediate full-table scan under ACCESS EXCLUSIVE lock, blocking ALL reads and writes for the duration of the scan.',
  defaultSeverity: 'BLOCKER',
  lockLevel: PostgresLockLevel.ACCESS_EXCLUSIVE,

  check(context: RuleContext): Finding[] {
    const findings: Finding[] = [];

    for (const stmt of context.statements) {
      if (stmt.hasIgnore(this.id) || stmt.hasIgnore('check-constraint-not-valid')) continue;

      const tokens = stmt.tokens;
      if (tokens.length < 5) continue;

      if (tokens[0].value !== 'ALTER' || tokens[1].value !== 'TABLE') continue;

      let idx = 2;
      while (idx < tokens.length) {
        if (tokens[idx]?.value === 'IF' && tokens[idx + 1]?.value === 'EXISTS') {
          idx += 2;
          continue;
        }
        if (tokens[idx]?.value === 'ONLY') {
          idx++;
          continue;
        }
        break;
      }
      const tableName = tokens[idx]?.raw ?? 'table';
      idx++;

      const clauses = extractCheckConstraintClauses(tokens.slice(idx));

      for (const clause of clauses) {
        if (!clause.hasNotValid) {
          const cName = clause.constraintName ?? 'chk_name';
          const cNameDisplay = clause.constraintName ? ` "${clause.constraintName}"` : '';

          findings.push({
            ruleId: this.id,
            ruleName: this.name,
            severity: this.defaultSeverity,
            lockLevel: this.lockLevel,
            message: `CHECK constraint${cNameDisplay} on table "${tableName}" added without NOT VALID.`,
            detail:
              'Adding a CHECK constraint without NOT VALID performs an immediate full-table scan under ACCESS EXCLUSIVE lock, blocking ALL reads and writes for the duration of the scan.',
            suggestion:
              `1. Add constraint without scanning existing rows:\n` +
              `   ALTER TABLE ${tableName} ADD CONSTRAINT ${cName} CHECK (...) NOT VALID;\n` +
              `2. Validate in a separate transaction (no ACCESS EXCLUSIVE lock on existing rows):\n` +
              `   ALTER TABLE ${tableName} VALIDATE CONSTRAINT ${cName};`,
            file: context.filePath,
            line: stmt.startLine,
            column: stmt.startColumn,
            codeSnippet: stmt.raw,
          });
        }
      }
    }

    return findings;
  },
};

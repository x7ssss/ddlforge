/**
 * ddlforge Rule: ADD CONSTRAINT ... FOREIGN KEY without NOT VALID
 *
 * Severity: BLOCKER
 * Lock: SHARE ROW EXCLUSIVE on child table + SHARE on parent table
 */

import { Rule, RuleContext, Finding } from './types.js';
import { PostgresLockLevel } from '../engine/locks.js';
import { Token } from '../lexer/tokens.js';

interface ForeignKeyClause {
  constraintName?: string;
  hasNotValid: boolean;
  tokens: Token[];
}

function extractForeignKeyClauses(tokens: Token[]): ForeignKeyClause[] {
  const clauses: ForeignKeyClause[] = [];
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

      // Check if this clause is FOREIGN KEY
      if (tokens[currentIdx]?.value === 'FOREIGN' && tokens[currentIdx + 1]?.value === 'KEY') {
        // Collect all tokens for this constraint until top-level comma or end
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

export const foreignKeyNotValidRule: Rule = {
  id: 'foreign-key-missing-not-valid',
  name: 'ADD CONSTRAINT FOREIGN KEY without NOT VALID',
  description: 'Adding a foreign key constraint without NOT VALID performs a full table scan under SHARE ROW EXCLUSIVE lock, blocking concurrent writes on both tables.',
  defaultSeverity: 'BLOCKER',
  lockLevel: PostgresLockLevel.SHARE_ROW_EXCLUSIVE,

  check(context: RuleContext): Finding[] {
    const findings: Finding[] = [];

    for (const stmt of context.statements) {
      if (stmt.hasIgnore(this.id)) continue;

      const tokens = stmt.tokens;
      if (tokens.length < 6) continue;

      if (tokens[0].value !== 'ALTER' || tokens[1].value !== 'TABLE') continue;

      // Extract table name
      let idx = 2;
      if (tokens[idx]?.value === 'ONLY') idx++;
      if (tokens[idx]?.value === 'IF' && tokens[idx + 1]?.value === 'EXISTS') idx += 2;
      const tableName = tokens[idx]?.raw ?? 'table';
      idx++;

      const fkClauses = extractForeignKeyClauses(tokens.slice(idx));

      for (const fk of fkClauses) {
        if (!fk.hasNotValid) {
          const cName = fk.constraintName ? ` "${fk.constraintName}"` : '';
          const validateSuggestion = fk.constraintName
            ? `ALTER TABLE ${tableName} VALIDATE CONSTRAINT ${fk.constraintName};`
            : `ALTER TABLE ${tableName} VALIDATE CONSTRAINT <constraint_name>;`;

          findings.push({
            ruleId: this.id,
            ruleName: this.name,
            severity: this.defaultSeverity,
            lockLevel: this.lockLevel,
            message: `Foreign key constraint${cName} on table "${tableName}" added without NOT VALID.`,
            detail:
              `Validating foreign keys inline holds a SHARE ROW EXCLUSIVE lock on "${tableName}" and a SHARE lock on the referenced table, ` +
              'blocking all concurrent writes (INSERT, UPDATE, DELETE) for the entire duration of the table scan.',
            suggestion:
              `1. Add constraint with NOT VALID:\n` +
              `   ALTER TABLE ${tableName} ADD CONSTRAINT ${fk.constraintName ?? 'fk_name'} FOREIGN KEY (...) REFERENCES (...) NOT VALID;\n` +
              `2. Validate concurrently without blocking writes:\n` +
              `   ${validateSuggestion}`,
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

/**
 * ddlforge Rule: ADD CONSTRAINT UNIQUE without pre-built index
 *
 * Severity: BLOCKER
 * Lock: SHARE
 */

import { Rule, RuleContext, Finding } from './types.js';
import { PostgresLockLevel } from '../engine/locks.js';
import { Token } from '../lexer/tokens.js';

interface UniqueConstraintClause {
  constraintName?: string;
  columns: string;
  isUsingIndex: boolean;
  tokens: Token[];
}

function extractUniqueConstraintClauses(tokens: Token[]): UniqueConstraintClause[] {
  const clauses: UniqueConstraintClause[] = [];
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

      // Check if this clause is a UNIQUE constraint
      if (tokens[currentIdx]?.value === 'UNIQUE') {
        currentIdx++;

        // If next significant token is USING, it's the safe USING INDEX form
        const isUsingIndex =
          tokens[currentIdx]?.value === 'USING' &&
          tokens[currentIdx + 1]?.value === 'INDEX';

        // Collect column list from the (...) after UNIQUE, if present
        let columns = '<columns>';
        if (!isUsingIndex && tokens[currentIdx]?.value === '(') {
          // Collect raw tokens inside the parens
          const colTokens: string[] = [];
          let subParen = 1;
          currentIdx++; // move past '('
          while (currentIdx < tokens.length && subParen > 0) {
            const t = tokens[currentIdx];
            if (t.value === '(') subParen++;
            else if (t.value === ')') {
              subParen--;
              if (subParen === 0) break;
            }
            colTokens.push(t.raw);
            currentIdx++;
          }
          columns = colTokens.join(', ');
        }

        // Collect all tokens for this constraint until top-level comma or end
        const clauseTokens: Token[] = [];
        let subParen = 0;
        // Reset to position right after UNIQUE keyword (already advanced above)
        // Re-scan from after UNIQUE to gather full clause tokens
        let scanIdx = i + 1;
        // Skip past CONSTRAINT <name> and UNIQUE
        if (tokens[scanIdx]?.value === 'CONSTRAINT') scanIdx += 2;
        scanIdx++; // skip UNIQUE

        while (scanIdx < tokens.length) {
          const t = tokens[scanIdx];
          if (t.value === '(') subParen++;
          if (t.value === ')') subParen--;

          if (subParen === 0 && t.value === ',') break;

          clauseTokens.push(t);
          scanIdx++;
        }

        clauses.push({
          constraintName,
          columns,
          isUsingIndex,
          tokens: clauseTokens,
        });

        i = scanIdx;
        continue;
      }
    }

    i++;
  }

  return clauses;
}

export const uniqueConstraintUsingIndexRule: Rule = {
  id: 'unique-constraint-using-index',
  name: 'ADD CONSTRAINT UNIQUE without pre-built index',
  description: 'Adding a UNIQUE constraint directly takes a SHARE lock and performs a full-table scan, blocking all concurrent writes (INSERT, UPDATE, DELETE) for the entire duration.',
  defaultSeverity: 'BLOCKER',
  lockLevel: PostgresLockLevel.SHARE,

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

      const clauses = extractUniqueConstraintClauses(tokens.slice(idx));

      for (const clause of clauses) {
        if (!clause.isUsingIndex) {
          const cName = clause.constraintName ?? 'uq_name';
          const cNameDisplay = clause.constraintName ? ` "${clause.constraintName}"` : '';
          const idxName = clause.constraintName ? `${clause.constraintName}_idx` : 'uq_idx_name';

          findings.push({
            ruleId: this.id,
            ruleName: this.name,
            severity: this.defaultSeverity,
            lockLevel: this.lockLevel,
            message: `UNIQUE constraint${cNameDisplay} on table "${tableName}" added without a pre-built index.`,
            detail:
              `Adding a UNIQUE constraint directly takes a SHARE lock and performs a full-table scan, blocking all concurrent writes (INSERT, UPDATE, DELETE) for the entire duration.`,
            suggestion:
              `1. Build the unique index concurrently first (no table lock):\n` +
              `   CREATE UNIQUE INDEX CONCURRENTLY ${idxName} ON ${tableName} (${clause.columns});\n` +
              `2. Attach it as a constraint without a table scan:\n` +
              `   ALTER TABLE ${tableName} ADD CONSTRAINT ${cName} UNIQUE USING INDEX ${idxName};`,
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

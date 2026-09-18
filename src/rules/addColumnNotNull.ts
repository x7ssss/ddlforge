/**
 * ddlforge Rule: ADD COLUMN NOT NULL without DEFAULT
 *
 * Severity: BLOCKER
 * Lock: ACCESS EXCLUSIVE
 */

import { Rule, RuleContext, Finding } from './types.js';
import { PostgresLockLevel } from '../engine/locks.js';
import { Token } from '../lexer/tokens.js';
import { buildNotNullColumnRemediation } from '../remediations/templates.js';

interface AddColumnClause {
  columnName: string;
  hasNotNull: boolean;
  hasDefault: boolean;
  hasGenerated: boolean;
  tokens: Token[];
}

function extractAddColumnClauses(tokens: Token[]): AddColumnClause[] {
  const clauses: AddColumnClause[] = [];
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

    // Check for ADD [COLUMN] at top level (parenDepth === 0)
    if (parenDepth === 0 && tokens[i].value === 'ADD') {
      let clauseIdx = i + 1;
      if (tokens[clauseIdx]?.value === 'COLUMN') {
        clauseIdx++;
      }

      // If next is IF NOT EXISTS, skip
      if (tokens[clauseIdx]?.value === 'IF' && tokens[clauseIdx + 1]?.value === 'NOT' && tokens[clauseIdx + 2]?.value === 'EXISTS') {
        clauseIdx += 3;
      }

      // Check if next token is CONSTRAINT or standard column definition
      if (tokens[clauseIdx]?.value === 'CONSTRAINT') {
        // Constraint definition, not a column
        i++;
        continue;
      }

      const columnName = tokens[clauseIdx]?.raw ?? 'column';
      clauseIdx++;

      // Collect tokens until next top-level comma or end of tokens
      let hasNotNull = false;
      let hasDefault = false;
      let hasGenerated = false;
      const clauseTokens: Token[] = [];
      let subParen = 0;

      while (clauseIdx < tokens.length) {
        const t = tokens[clauseIdx];
        if (t.value === '(') subParen++;
        if (t.value === ')') subParen--;

        if (subParen === 0 && t.value === ',') {
          break; // next subcommand
        }

        clauseTokens.push(t);

        if (t.value === 'NOT' && tokens[clauseIdx + 1]?.value === 'NULL') {
          hasNotNull = true;
        }
        if (t.value === 'DEFAULT') {
          hasDefault = true;
        }
        if (t.value === 'GENERATED') {
          hasGenerated = true;
        }

        clauseIdx++;
      }

      clauses.push({
        columnName,
        hasNotNull,
        hasDefault,
        hasGenerated,
        tokens: clauseTokens,
      });

      i = clauseIdx;
      continue;
    }

    i++;
  }

  return clauses;
}

export const addColumnNotNullRule: Rule = {
  id: 'add-column-not-null-without-default',
  name: 'ADD COLUMN NOT NULL without DEFAULT',
  description: 'Adding a NOT NULL column without a DEFAULT value will immediately fail on non-empty tables and hold an ACCESS EXCLUSIVE lock.',
  defaultSeverity: 'BLOCKER',
  lockLevel: PostgresLockLevel.ACCESS_EXCLUSIVE,

  check(context: RuleContext): Finding[] {
    const findings: Finding[] = [];

    for (const stmt of context.statements) {
      if (stmt.hasIgnore(this.id)) continue;

      const tokens = stmt.tokens;
      if (tokens.length < 5) continue;

      if (tokens[0].value !== 'ALTER' || tokens[1].value !== 'TABLE') continue;

      // Extract table name
      let idx = 2;
      if (tokens[idx]?.value === 'ONLY') idx++;
      if (tokens[idx]?.value === 'IF' && tokens[idx + 1]?.value === 'EXISTS') idx += 2;
      const tableName = tokens[idx]?.raw ?? 'table';
      idx++;

      // Scan through subcommands separated by comma (at top parentheses depth)
      const clauses = extractAddColumnClauses(tokens.slice(idx));

      for (const clause of clauses) {
        if (clause.hasNotNull && !clause.hasDefault && !clause.hasGenerated) {
          const typeTokens = clause.tokens.filter(
            t => t.value !== 'NOT' && t.value !== 'NULL' && t.value !== 'DEFAULT' && t.value !== 'GENERATED'
          );
          const colType = typeTokens.map(t => t.raw).join(' ') || 'TEXT';
          const recipe = buildNotNullColumnRemediation({
            table: tableName,
            column: clause.columnName,
            type: colType,
          });

          findings.push({
            ruleId: this.id,
            ruleName: this.name,
            severity: this.defaultSeverity,
            lockLevel: this.lockLevel,
            message: `Column "${clause.columnName}" added as NOT NULL without a DEFAULT value on table "${tableName}".`,
            detail:
              `Adding a NOT NULL column without a DEFAULT on non-empty table "${tableName}" will immediately fail ` +
              'with `column "..." contains null values` while holding an ACCESS EXCLUSIVE table lock.',
            suggestion:
              `Provide a DEFAULT value: \`ALTER TABLE ${tableName} ADD COLUMN ${clause.columnName} <type> DEFAULT <val> NOT NULL;\` ` +
              `or add nullable first, backfill rows in batches, and apply a validated NOT NULL constraint.`,
            file: context.filePath,
            line: stmt.startLine,
            column: stmt.startColumn,
            codeSnippet: stmt.raw,
            remediation: recipe.fullSql,
          });
        }
      }
    }

    return findings;
  },
};

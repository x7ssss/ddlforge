/**
 * ddlforge Rule: ADD PRIMARY KEY without pre-built index
 *
 * Severity: BLOCKER
 * Lock: ACCESS EXCLUSIVE
 */

import { Rule, RuleContext, Finding } from './types.js';
import { PostgresLockLevel } from '../engine/locks.js';
import { Token } from '../lexer/tokens.js';
import { buildPrimaryKeyUsingIndexRemediation } from '../remediations/templates.js';

interface PrimaryKeyClause {
  constraintName?: string;
  columns: string;
  isUsingIndex: boolean;
  tokens: Token[];
}

function extractPrimaryKeyClauses(tokens: Token[]): PrimaryKeyClause[] {
  const clauses: PrimaryKeyClause[] = [];
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
        if (currentIdx < tokens.length && tokens[currentIdx].value !== 'PRIMARY') {
          constraintName = tokens[currentIdx].raw;
          currentIdx++;
        }
      }

      // Check if this clause is PRIMARY KEY
      if (tokens[currentIdx]?.value === 'PRIMARY' && tokens[currentIdx + 1]?.value === 'KEY') {
        currentIdx += 2;

        let isUsingIndex = false;
        let columns = '<columns>';
        let subParen = 0;
        const colTokens: string[] = [];
        const clauseTokens: Token[] = [];

        let scan = currentIdx;
        while (scan < tokens.length) {
          const t = tokens[scan];

          if (t.value === '(') {
            subParen++;
            if (subParen === 1) {
              scan++;
              continue;
            }
          } else if (t.value === ')') {
            subParen--;
            if (subParen === 0) {
              scan++;
              continue;
            }
          }

          if (subParen === 0 && (t.value === ',' || t.value === ';')) {
            break;
          }

          clauseTokens.push(t);

          // Check for USING INDEX anywhere in the clause
          if (t.value === 'USING' && tokens[scan + 1]?.value === 'INDEX') {
            isUsingIndex = true;
          }

          // Collect column tokens inside parens
          if (subParen > 0) {
            if (t.value !== ',') {
              colTokens.push(t.raw);
            }
          }

          scan++;
        }

        if (colTokens.length > 0) {
          columns = colTokens.join(', ');
        }

        clauses.push({
          constraintName,
          columns,
          isUsingIndex,
          tokens: clauseTokens,
        });

        i = scan;
        continue;
      }
    }

    i++;
  }

  return clauses;
}

export const addPrimaryKeyMissingUsingIndexRule: Rule = {
  id: 'add-primary-key-missing-using-index',
  name: 'ADD PRIMARY KEY without pre-built index',
  description:
    'Adding a PRIMARY KEY constraint directly acquires an ACCESS EXCLUSIVE lock and performs a full-table index build, blocking all concurrent queries (SELECT, INSERT, UPDATE, DELETE) for the entire duration.',
  defaultSeverity: 'BLOCKER',
  lockLevel: PostgresLockLevel.ACCESS_EXCLUSIVE,

  check(context: RuleContext): Finding[] {
    const findings: Finding[] = [];

    for (const stmt of context.statements) {
      if (stmt.hasIgnore(this.id)) continue;

      const tokens = stmt.tokens;
      if (tokens.length < 5) continue;

      if (tokens[0].value !== 'ALTER' || tokens[1].value !== 'TABLE') continue;

      let idx = 2;
      // 1. Modifiers before table name (IF EXISTS, ONLY)
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

      // 2. Table name (supports public.orders, "public"."orders", etc.)
      const tableParts: string[] = [];
      if (idx < tokens.length) {
        tableParts.push(tokens[idx].raw);
        idx++;
        while (idx < tokens.length && tokens[idx]?.value === '.') {
          tableParts.push('.');
          idx++;
          if (idx < tokens.length) {
            tableParts.push(tokens[idx].raw);
            idx++;
          }
        }
      }
      const tableName = tableParts.join('') || 'table';

      // 3. Modifiers after table name (optional '*' or 'ONLY')
      while (idx < tokens.length) {
        if (tokens[idx]?.value === '*') {
          idx++;
          continue;
        }
        if (tokens[idx]?.value === 'ONLY') {
          idx++;
          continue;
        }
        break;
      }

      const clauses = extractPrimaryKeyClauses(tokens.slice(idx));

      for (const clause of clauses) {
        if (!clause.isUsingIndex) {
          const cleanTable = tableName.replace(/["`]/g, '').replace(/[^a-zA-Z0-9_]/g, '_');
          const cName = clause.constraintName ?? `${cleanTable}_pkey`;
          const cNameDisplay = clause.constraintName ? ` "${clause.constraintName}"` : '';
          const idxName = clause.constraintName ? `${clause.constraintName}_idx` : `${cleanTable}_pkey_idx`;

          const recipe = buildPrimaryKeyUsingIndexRemediation({
            table: tableName,
            constraintName: clause.constraintName,
            columns: clause.columns.split(',').map(s => s.trim()),
            indexName: idxName,
          });

          findings.push({
            ruleId: this.id,
            ruleName: this.name,
            severity: this.defaultSeverity,
            lockLevel: this.lockLevel,
            message: `PRIMARY KEY constraint${cNameDisplay} on table "${tableName}" added without USING INDEX.`,
            detail:
              `Adding a PRIMARY KEY directly acquires an ACCESS EXCLUSIVE lock and builds the index synchronously, ` +
              `blocking all concurrent reads and writes for the duration of the build.`,
            suggestion:
              `1. Build a unique index concurrently first (no table lock):\n` +
              `   CREATE UNIQUE INDEX CONCURRENTLY ${idxName} ON ${tableName} (${clause.columns});\n` +
              `2. Attach it as a primary key constraint instantaneously:\n` +
              `   ALTER TABLE ${tableName} ADD CONSTRAINT ${cName} PRIMARY KEY USING INDEX ${idxName};`,
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

/**
 * ddlforge Rule: Volatile DEFAULT expression on ADD COLUMN
 *
 * Severity: BLOCKER
 * Lock: ACCESS EXCLUSIVE (forces full table rewrite)
 *
 * PostgreSQL 11+ optimizes ADD COLUMN with constant default expressions
 * into an instantaneous O(1) catalog update. However, volatile expressions
 * (such as clock_timestamp(), random(), uuid_generate_v4(), now(), gen_random_uuid())
 * cannot be evaluated once for catalog metadata; they force PostgreSQL to perform
 * a complete table rewrite while holding an ACCESS EXCLUSIVE lock.
 */

import { Rule, RuleContext, Finding } from './types.js';
import { PostgresLockLevel } from '../engine/locks.js';
import { Token } from '../lexer/tokens.js';

const VOLATILE_PATTERNS = [
  /\bclock_timestamp\s*\(/i,
  /\brandom\s*\(/i,
  /\buuid_generate_v4\s*\(/i,
  /\bnow\s*\(/i,
  /\bgen_random_uuid\s*\(/i,
  /\btimeofday\s*\(/i,
  /\bstatement_timestamp\s*\(/i,
  /\btransaction_timestamp\s*\(/i,
];

function isVolatileExpression(expr: string): boolean {
  return VOLATILE_PATTERNS.some(pat => pat.test(expr));
}

interface VolatileDefaultClause {
  columnName: string;
  defaultExpr: string;
}

function extractVolatileDefaultClauses(tokens: Token[]): VolatileDefaultClause[] {
  const clauses: VolatileDefaultClause[] = [];
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
      let idx = i + 1;
      if (tokens[idx]?.value === 'COLUMN') {
        idx++;
      }
      if (tokens[idx]?.value === 'IF' && tokens[idx + 1]?.value === 'NOT' && tokens[idx + 2]?.value === 'EXISTS') {
        idx += 3;
      }
      if (tokens[idx]?.value === 'CONSTRAINT') {
        i++;
        continue;
      }

      const columnName = tokens[idx]?.raw ?? 'column';
      idx++;

      // Scan through column definition for DEFAULT keyword
      let subParen = 0;
      let defaultFound = false;
      const defaultTokens: string[] = [];

      while (idx < tokens.length) {
        const t = tokens[idx];
        if (t.value === '(') subParen++;
        if (t.value === ')') subParen--;

        if (subParen === 0 && t.value === ',') {
          break;
        }

        if (subParen === 0 && t.value === 'DEFAULT') {
          defaultFound = true;
          idx++;
          continue;
        }

        if (defaultFound) {
          // If we hit trailing keywords outside parens like NOT NULL or CHECK or CONSTRAINT, stop collecting DEFAULT expr
          if (
            subParen === 0 &&
            (t.value === 'NOT' || t.value === 'NULL' || t.value === 'CHECK' || t.value === 'CONSTRAINT' || t.value === 'COLLATE')
          ) {
            break;
          }
          defaultTokens.push(t.raw);
        }

        idx++;
      }

      if (defaultFound && defaultTokens.length > 0) {
        const expr = defaultTokens
          .join(' ')
          .replace(/\s*\(\s*/g, '(')
          .replace(/\s*\)/g, ')')
          .replace(/\s*::\s*/g, '::')
          .trim();
        if (isVolatileExpression(expr)) {
          clauses.push({ columnName, defaultExpr: expr });
        }
      }

      i = idx;
      continue;
    }

    i++;
  }

  return clauses;
}

export const volatileDefaultRule: Rule = {
  id: 'volatile-default',
  name: 'Volatile DEFAULT expression on ADD COLUMN',
  description:
    'Adding a column with a volatile default expression (clock_timestamp(), random(), uuid_generate_v4(), now()) forces a full table rewrite holding an ACCESS EXCLUSIVE lock.',
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

      const clauses = extractVolatileDefaultClauses(tokens.slice(idx));

      for (const clause of clauses) {
        findings.push({
          ruleId: this.id,
          ruleName: this.name,
          severity: this.defaultSeverity,
          lockLevel: this.lockLevel,
          message: `Column "${clause.columnName}" added with volatile DEFAULT expression "${clause.defaultExpr}" on table "${tableName}".`,
          detail:
            `PostgreSQL cannot optimize volatile default expressions into an O(1) metadata update. ` +
            `Adding "${clause.columnName}" with DEFAULT ${clause.defaultExpr} forces a complete rewrite of table "${tableName}" ` +
            `under an ACCESS EXCLUSIVE lock, blocking all concurrent SELECT, INSERT, UPDATE, and DELETE operations.`,
          suggestion:
            `Zero-downtime 3-phase remediation pattern:\n` +
            `  1. Add column nullable without default:\n` +
            `     ALTER TABLE ${tableName} ADD COLUMN ${clause.columnName} <type>;\n` +
            `  2. Backfill existing rows asynchronously in batches.\n` +
            `  3. Set default expression for future rows:\n` +
            `     ALTER TABLE ${tableName} ALTER COLUMN ${clause.columnName} SET DEFAULT ${clause.defaultExpr};`,
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

/**
 * ddlforge Rule: CREATE INDEX missing CONCURRENTLY
 *
 * Severity: BLOCKER
 * Lock: SHARE (blocks all INSERT, UPDATE, DELETE)
 */

import { Rule, RuleContext, Finding } from './types.js';
import { PostgresLockLevel } from '../engine/locks.js';
import { TokenType } from '../lexer/tokens.js';

export const indexConcurrentlyRule: Rule = {
  id: 'require-concurrent-index',
  name: 'CREATE INDEX without CONCURRENTLY',
  description: 'CREATE INDEX acquires a SHARE lock, blocking all concurrent INSERT, UPDATE, and DELETE operations.',
  defaultSeverity: 'BLOCKER',
  lockLevel: PostgresLockLevel.SHARE,

  check(context: RuleContext): Finding[] {
    const findings: Finding[] = [];

    for (const stmt of context.statements) {
      if (stmt.hasIgnore(this.id)) continue;

      const tokens = stmt.tokens;
      if (tokens.length < 3) continue;

      let idx = 0;
      if (tokens[idx].value !== 'CREATE') continue;
      idx++;

      let isUnique = false;
      if (tokens[idx]?.value === 'UNIQUE') {
        isUnique = true;
        idx++;
      }

      if (tokens[idx]?.value !== 'INDEX') continue;
      idx++;

      // Check if CONCURRENTLY is present before the 'ON' keyword
      let hasConcurrently = false;
      let onIndex = -1;
      let indexName = '';

      for (let i = idx; i < tokens.length; i++) {
        if (tokens[i].value === 'CONCURRENTLY') {
          hasConcurrently = true;
        }
        if (tokens[i].value === 'ON') {
          onIndex = i;
          break;
        }
        if (!hasConcurrently && tokens[i].value !== 'IF' && tokens[i].value !== 'NOT' && tokens[i].value !== 'EXISTS') {
          if (!indexName && (tokens[i].type === TokenType.IDENTIFIER || tokens[i].type === TokenType.KEYWORD)) {
            indexName = tokens[i].raw;
          }
        }
      }

      // If there is no 'ON', it's not a valid standard CREATE INDEX statement
      if (onIndex === -1) continue;

      if (!hasConcurrently) {
        // Find table name after ON
        let tableName = '';
        if (onIndex + 1 < tokens.length) {
          const tableToken = tokens[onIndex + 1];
          if (tableToken.value === 'ONLY' && onIndex + 2 < tokens.length) {
            tableName = tokens[onIndex + 2].raw;
          } else {
            tableName = tableToken.raw;
          }
        }

        const prefix = isUnique ? 'CREATE UNIQUE INDEX CONCURRENTLY' : 'CREATE INDEX CONCURRENTLY';
        const restOfStatement = stmt.raw
          .replace(/^CREATE\s+(UNIQUE\s+)?INDEX\s+/i, '')
          .trim();

        const suggestedFix = `${prefix} ${restOfStatement};`;

        findings.push({
          ruleId: this.id,
          ruleName: this.name,
          severity: this.defaultSeverity,
          lockLevel: this.lockLevel,
          message: `CREATE ${isUnique ? 'UNIQUE ' : ''}INDEX missing CONCURRENTLY keyword.`,
          detail:
            'Building an index without CONCURRENTLY acquires a SHARE lock on the target table. ' +
            'This blocks all concurrent write operations (INSERT, UPDATE, DELETE) for the entire duration of the build.',
          suggestion: `Add the CONCURRENTLY modifier: \`${suggestedFix}\` (Note: Run outside of an explicit transaction).`,
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

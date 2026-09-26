/**
 * ddlforge Rule: DROP INDEX without CONCURRENTLY
 *
 * Severity: BLOCKER
 * Lock: ACCESS EXCLUSIVE (blocks all SELECT, INSERT, UPDATE, DELETE)
 */

import { Rule, RuleContext, Finding } from './types.js';
import { PostgresLockLevel } from '../engine/locks.js';

export const nonConcurrentDropIndexRule: Rule = {
  id: 'non-concurrent-drop-index',
  name: 'DROP INDEX without CONCURRENTLY',
  description:
    'Dropping an index without CONCURRENTLY acquires an ACCESS EXCLUSIVE lock on the indexed table, blocking all concurrent queries (SELECT, INSERT, UPDATE, DELETE).',
  defaultSeverity: 'BLOCKER',
  lockLevel: PostgresLockLevel.ACCESS_EXCLUSIVE,

  check(context: RuleContext): Finding[] {
    const findings: Finding[] = [];

    for (const stmt of context.statements) {
      if (stmt.hasIgnore(this.id)) continue;

      const tokens = stmt.tokens;
      if (tokens.length < 2) continue;

      if (tokens[0].value !== 'DROP' || tokens[1].value !== 'INDEX') continue;

      // Check if CONCURRENTLY is present anywhere in DROP INDEX statement
      let hasConcurrently = false;
      for (let i = 2; i < tokens.length; i++) {
        if (tokens[i].value === 'CONCURRENTLY') {
          hasConcurrently = true;
          break;
        }
      }

      if (!hasConcurrently) {
        // Extract index name (skip IF EXISTS)
        let idx = 2;
        if (tokens[idx]?.value === 'IF' && tokens[idx + 1]?.value === 'EXISTS') {
          idx += 2;
        }
        const indexName = tokens[idx]?.raw ?? 'index_name';

        findings.push({
          ruleId: this.id,
          ruleName: this.name,
          severity: this.defaultSeverity,
          lockLevel: this.lockLevel,
          message: `DROP INDEX "${indexName}" missing CONCURRENTLY keyword.`,
          detail:
            `Dropping an index without CONCURRENTLY acquires an ACCESS EXCLUSIVE lock on the target table. ` +
            `This blocks all concurrent reads and writes for the duration of the drop.`,
          suggestion:
            `Add the CONCURRENTLY modifier:\n` +
            `   DROP INDEX CONCURRENTLY ${indexName};\n` +
            `(Note: CONCURRENTLY cannot run inside an explicit transaction block; execute as a standalone autocommit statement).`,
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

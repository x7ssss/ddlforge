/**
 * ddlforge Rule: REINDEX lacking CONCURRENTLY
 *
 * Rule ID: reindex-missing-concurrently
 * Severity: BLOCKER
 * Lock: ACCESS EXCLUSIVE
 */

import { Rule, RuleContext, Finding } from './types.js';
import { PostgresLockLevel } from '../engine/locks.js';

const REINDEX_TARGET_TYPES = new Set(['INDEX', 'TABLE', 'SCHEMA', 'DATABASE', 'SYSTEM']);

export const reindexMissingConcurrentlyRule: Rule = {
  id: 'reindex-missing-concurrently',
  name: 'REINDEX lacking CONCURRENTLY',
  description:
    'REINDEX without CONCURRENTLY acquires an ACCESS EXCLUSIVE or SHARE lock on the target table, blocking all concurrent writes (and reads on affected tables) for the entire duration of index rebuilding.',
  defaultSeverity: 'BLOCKER',
  lockLevel: PostgresLockLevel.ACCESS_EXCLUSIVE,

  check(context: RuleContext): Finding[] {
    const findings: Finding[] = [];

    for (const stmt of context.statements) {
      if (stmt.hasIgnore(this.id)) continue;

      const tokens = stmt.tokens;
      if (tokens.length < 2) continue;

      if (tokens[0].value !== 'REINDEX') continue;

      // Check if CONCURRENTLY is present anywhere in the statement
      const hasConcurrently = tokens.some(t => t.value === 'CONCURRENTLY');
      if (hasConcurrently) continue;

      // Determine target type and name
      let targetType = 'OBJECT';
      let targetName = 'target';

      let i = 1;
      // Skip options in parens e.g. REINDEX (VERBOSE) TABLE t
      if (tokens[i]?.value === '(') {
        let pDepth = 1;
        i++;
        while (i < tokens.length && pDepth > 0) {
          if (tokens[i].value === '(') pDepth++;
          if (tokens[i].value === ')') pDepth--;
          i++;
        }
      }

      if (i < tokens.length && REINDEX_TARGET_TYPES.has(tokens[i]?.value)) {
        targetType = tokens[i].value;
        i++;
        if (i < tokens.length && tokens[i].value !== ';') {
          targetName = tokens[i].raw;
        }
      } else if (i < tokens.length && tokens[i].value !== ';') {
        targetName = tokens[i].raw;
      }

      findings.push({
        ruleId: this.id,
        ruleName: this.name,
        severity: this.defaultSeverity,
        lockLevel: this.lockLevel,
        message: `REINDEX ${targetType} "${targetName}" executed without CONCURRENTLY.`,
        detail:
          `Reindexing without CONCURRENTLY locks the underlying table, preventing concurrent writes ` +
          `(and in some cases reads) for the entire duration of the rebuild.`,
        suggestion:
          `Add the CONCURRENTLY keyword and execute outside a transaction block:\n` +
          `   REINDEX ${targetType === 'OBJECT' ? 'TABLE' : targetType} CONCURRENTLY ${targetName};`,
        file: context.filePath,
        line: stmt.startLine,
        column: stmt.startColumn,
        codeSnippet: stmt.raw,
      });
    }

    return findings;
  },
};

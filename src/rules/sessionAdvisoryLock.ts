/**
 * ddlforge Rule: Session-level advisory lock
 *
 * Severity: WARNING
 * Lock: NONE
 */

import { Rule, RuleContext, Finding } from './types.js';
import { PostgresLockLevel } from '../engine/locks.js';

export const sessionAdvisoryLockRule: Rule = {
  id: 'session-advisory-lock',
  name: 'Session-level advisory lock',
  description: 'Session-level advisory locks (pg_advisory_lock / pg_try_advisory_lock) are tied to the database connection, not the transaction. In connection-pooled environments, these locks leak across connections.',
  defaultSeverity: 'WARNING',
  lockLevel: PostgresLockLevel.NONE,

  check(context: RuleContext): Finding[] {
    const findings: Finding[] = [];

    for (const stmt of context.statements) {
      if (stmt.hasIgnore(this.id)) continue;

      for (const token of stmt.tokens) {
        const raw = token.raw;

        // Match pg_advisory_lock or pg_try_advisory_lock (case-insensitive)
        // but NOT pg_advisory_xact_lock or pg_try_advisory_xact_lock
        if (
          /^pg_(try_)?advisory_lock$/i.test(raw) &&
          !/^pg_(try_)?advisory_xact_lock$/i.test(raw)
        ) {
          findings.push({
            ruleId: this.id,
            ruleName: this.name,
            severity: this.defaultSeverity,
            lockLevel: this.lockLevel,
            message: `Session-level advisory lock "${raw}(...)" detected.`,
            detail:
              `Session-level advisory locks (pg_advisory_lock / pg_try_advisory_lock) are tied to the database connection, not the transaction. ` +
              `In connection-pooled environments (PgBouncer transaction mode), these locks leak across connections, leading to stranded locks and potential migration deadlocks.`,
            suggestion:
              `Replace with transaction-scoped variants that auto-release on COMMIT or ROLLBACK:\n` +
              `   pg_advisory_xact_lock(key)     -- blocks until acquired\n` +
              `   pg_try_advisory_xact_lock(key) -- returns false if not immediately available`,
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

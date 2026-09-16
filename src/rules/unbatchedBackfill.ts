/**
 * ddlforge Rule: Unbatched DML in Migration (Bare UPDATE/DELETE)
 *
 * Severity: WARNING
 * Lock: ROW EXCLUSIVE
 */

import { Rule, RuleContext, Finding } from './types.js';
import { PostgresLockLevel } from '../engine/locks.js';

export const unbatchedBackfillRule: Rule = {
  id: 'unbatched-dml',
  name: 'Unbatched DML in Migration',
  description: 'Bare UPDATE and DELETE statements in migrations can lock millions of rows, bloat WAL, and block autovacuum.',
  defaultSeverity: 'WARNING',
  lockLevel: PostgresLockLevel.ROW_EXCLUSIVE,

  check(context: RuleContext): Finding[] {
    const findings: Finding[] = [];

    for (const stmt of context.statements) {
      if (stmt.hasIgnore(this.id)) continue;

      const tokens = stmt.tokens;
      if (tokens.length < 2) continue;

      const firstVal = tokens[0].value;
      const isUpdate = firstVal === 'UPDATE';
      const isDelete = firstVal === 'DELETE' && tokens[1]?.value === 'FROM';

      if (!isUpdate && !isDelete) continue;

      // Check for batching comments: -- batch, -- batched, -- batch-size
      const hasBatchComment = stmt.comments.some(c => /batch/i.test(c));
      if (hasBatchComment) continue;

      // Check if statement contains LIMIT inside a subquery
      const hasLimit = tokens.some(t => t.value === 'LIMIT');
      if (hasLimit) continue;

      // Check if WHERE clause exists
      const hasWhere = tokens.some(t => t.value === 'WHERE');
      const opName = isUpdate ? 'UPDATE' : 'DELETE';

      const tableName = isUpdate ? (tokens[1]?.raw ?? 'table') : (tokens[2]?.raw ?? 'table');

      findings.push({
        ruleId: this.id,
        ruleName: this.name,
        severity: !hasWhere ? 'BLOCKER' : this.defaultSeverity,
        lockLevel: this.lockLevel,
        message: `Bare ${opName} statement on table "${tableName}" without batching or LIMIT.`,
        detail:
          `Unbatched ${opName} statements in migrations hold ROW EXCLUSIVE locks on affected rows for the duration of the migration transaction, ` +
          'generating massive WAL volume and risking transaction timeouts.',
        suggestion:
          'Migrate large backfills out-of-band using asynchronous background jobs in small batches (1,000–5,000 rows). ' +
          'If this operation targets a small static/lookup table, add `-- ddlforge-ignore unbatched-dml`.',
        file: context.filePath,
        line: stmt.startLine,
        column: stmt.startColumn,
        codeSnippet: stmt.raw,
      });
    }

    return findings;
  },
};

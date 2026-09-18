/**
 * ddlforge Rule: Maintenance command (VACUUM FULL, CLUSTER, TRUNCATE) detected in migration
 *
 * Rule ID: maintenance-command-detected
 * Severity: BLOCKER
 * Lock: ACCESS EXCLUSIVE
 */

import { Rule, RuleContext, Finding } from './types.js';
import { PostgresLockLevel } from '../engine/locks.js';

export const maintenanceCommandDetectedRule: Rule = {
  id: 'maintenance-command-detected',
  name: 'Maintenance command (VACUUM FULL, CLUSTER, TRUNCATE) in migration',
  description:
    'Maintenance operations like VACUUM FULL, CLUSTER, or TRUNCATE lock tables exclusively, block all concurrent reads/writes, or cause destructive data loss and should never be run in online schema migrations.',
  defaultSeverity: 'BLOCKER',
  lockLevel: PostgresLockLevel.ACCESS_EXCLUSIVE,

  check(context: RuleContext): Finding[] {
    const findings: Finding[] = [];

    for (const stmt of context.statements) {
      if (stmt.hasIgnore(this.id)) continue;

      const tokens = stmt.tokens;
      if (tokens.length === 0) continue;

      const firstVal = tokens[0].value;

      // 1. VACUUM [FULL]
      if (firstVal === 'VACUUM') {
        const isFull = tokens.some(t => t.value === 'FULL');
        const cmdName = isFull ? 'VACUUM FULL' : 'VACUUM';

        findings.push({
          ruleId: this.id,
          ruleName: this.name,
          severity: this.defaultSeverity,
          lockLevel: this.lockLevel,
          message: `Maintenance command "${cmdName}" detected in migration.`,
          detail: isFull
            ? 'VACUUM FULL completely rewrites the target table under an ACCESS EXCLUSIVE lock, blocking all concurrent reads and writes, and cannot be run inside a transaction block.'
            : 'VACUUM cannot be run inside an explicit transaction block and should be executed out-of-band via pg_autovacuum or scheduled maintenance jobs.',
          suggestion:
            'Do not run VACUUM FULL in migrations. Use pg_repack or pg_squeeze for online table reorganization without blocking reads or writes.',
          file: context.filePath,
          line: stmt.startLine,
          column: stmt.startColumn,
          codeSnippet: stmt.raw,
        });
        continue;
      }

      // 2. CLUSTER
      if (firstVal === 'CLUSTER') {
        findings.push({
          ruleId: this.id,
          ruleName: this.name,
          severity: this.defaultSeverity,
          lockLevel: this.lockLevel,
          message: 'Maintenance command "CLUSTER" detected in migration.',
          detail:
            'CLUSTER rewrites the table on disk ordered by an index under ACCESS EXCLUSIVE lock, blocking all concurrent reads and writes for the duration of the operation.',
          suggestion:
            'Avoid CLUSTER in online migrations. If clustering is required, perform it out-of-band using pg_repack or scheduled maintenance windows.',
          file: context.filePath,
          line: stmt.startLine,
          column: stmt.startColumn,
          codeSnippet: stmt.raw,
        });
        continue;
      }

      // 3. TRUNCATE
      if (firstVal === 'TRUNCATE') {
        let tableName = 'table';
        let i = 1;
        if (tokens[i]?.value === 'TABLE') i++;
        if (tokens[i]?.value === 'ONLY') i++;
        if (tokens[i]) tableName = tokens[i].raw;

        findings.push({
          ruleId: this.id,
          ruleName: this.name,
          severity: this.defaultSeverity,
          lockLevel: this.lockLevel,
          message: `Destructive maintenance command "TRUNCATE" on "${tableName}" detected in migration.`,
          detail:
            'TRUNCATE acquires an ACCESS EXCLUSIVE lock and immediately removes all table rows, risking irreversible data loss and blocking all concurrent queries.',
          suggestion:
            'Use batched DELETE statements with LIMIT, or drop individual partitions if truncating a partitioned table.',
          file: context.filePath,
          line: stmt.startLine,
          column: stmt.startColumn,
          codeSnippet: stmt.raw,
        });
        continue;
      }
    }

    return findings;
  },
};

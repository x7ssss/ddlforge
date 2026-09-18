/**
 * ddlforge Rule: ALTER TABLE DETACH PARTITION lacking CONCURRENTLY
 *
 * Rule ID: detach-partition-non-concurrent
 * Severity: BLOCKER
 * Lock: ACCESS EXCLUSIVE
 */

import { Rule, RuleContext, Finding } from './types.js';
import { PostgresLockLevel } from '../engine/locks.js';

export const detachPartitionNonConcurrentRule: Rule = {
  id: 'detach-partition-non-concurrent',
  name: 'ALTER TABLE DETACH PARTITION lacking CONCURRENTLY',
  description:
    'Detaching a partition without CONCURRENTLY takes an ACCESS EXCLUSIVE lock on both the partitioned table and the partition, blocking all concurrent transactions (including SELECT).',
  defaultSeverity: 'BLOCKER',
  lockLevel: PostgresLockLevel.ACCESS_EXCLUSIVE,

  check(context: RuleContext): Finding[] {
    const findings: Finding[] = [];

    // CONCURRENTLY for DETACH PARTITION was introduced in PostgreSQL 14
    if (context.pgVersion < 14) {
      return findings;
    }

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
      const tableName = tokens[idx]?.raw ?? 'table';
      idx++;

      // Scan for DETACH PARTITION
      while (idx < tokens.length) {
        if (tokens[idx]?.value === 'DETACH' && tokens[idx + 1]?.value === 'PARTITION') {
          idx += 2;

          let partitionName = '<partition>';
          let hasConcurrently = false;

          // Collect tokens until end of statement or semicolon / comma
          while (idx < tokens.length && tokens[idx].value !== ';' && tokens[idx].value !== ',') {
            const val = tokens[idx].value;
            if (val === 'CONCURRENTLY' || val === 'FINALIZE') {
              hasConcurrently = true;
            } else if (val === 'IF' && tokens[idx + 1]?.value === 'EXISTS') {
              idx += 2;
              continue;
            } else if (val !== '(' && val !== ')' && partitionName === '<partition>') {
              partitionName = tokens[idx].raw;
            }
            idx++;
          }

          if (!hasConcurrently) {
            findings.push({
              ruleId: this.id,
              ruleName: this.name,
              severity: this.defaultSeverity,
              lockLevel: this.lockLevel,
              message: `Partition "${partitionName}" detached from "${tableName}" without CONCURRENTLY.`,
              detail:
                `Detaching a partition without CONCURRENTLY takes an ACCESS EXCLUSIVE lock on both the partitioned table ` +
                `and the partition, blocking all concurrent queries (including SELECT) until all active transactions finish.`,
              suggestion:
                `Add the CONCURRENTLY modifier and run outside a transaction block:\n` +
                `   ALTER TABLE ${tableName} DETACH PARTITION ${partitionName} CONCURRENTLY;`,
              file: context.filePath,
              line: stmt.startLine,
              column: stmt.startColumn,
              codeSnippet: stmt.raw,
            });
          }
          break;
        }
        idx++;
      }
    }

    return findings;
  },
};

/**
 * ddlforge Rule: CONCURRENTLY inside Transaction Trap
 *
 * Severity: BLOCKER
 * Engine behavior: Postgres aborts execution with `ERROR: CREATE INDEX CONCURRENTLY cannot run inside a transaction block`
 */

import { Rule, RuleContext, Finding } from './types.js';
import { PostgresLockLevel } from '../engine/locks.js';

function isConcurrentIndexStatement(tokens: Array<{ value: string }>): boolean {
  if (tokens.length < 3) return false;

  // CREATE [UNIQUE] INDEX CONCURRENTLY
  if (tokens[0].value === 'CREATE') {
    let idx = 1;
    if (tokens[idx]?.value === 'UNIQUE') idx++;
    if (tokens[idx]?.value === 'INDEX') {
      for (let i = idx + 1; i < tokens.length; i++) {
        if (tokens[i].value === 'ON') break;
        if (tokens[i].value === 'CONCURRENTLY') return true;
      }
    }
  }

  // DROP INDEX CONCURRENTLY
  if (tokens[0].value === 'DROP' && tokens[1]?.value === 'INDEX') {
    for (let i = 2; i < tokens.length; i++) {
      if (tokens[i].value === 'CONCURRENTLY') return true;
    }
  }

  return false;
}

export const transactionTrapRule: Rule = {
  id: 'concurrent-index-in-transaction',
  name: 'CONCURRENTLY inside Transaction Trap',
  description: 'PostgreSQL aborts transactions containing concurrent index builds or drops.',
  defaultSeverity: 'BLOCKER',
  lockLevel: PostgresLockLevel.NONE,

  check(context: RuleContext): Finding[] {
    const findings: Finding[] = [];
    let inExplicitTransaction = false;
    let transactionStartLine = 1;

    for (const stmt of context.statements) {
      const tokens = stmt.tokens;
      if (tokens.length === 0) continue;

      const firstVal = tokens[0].value;

      // Detect transaction start
      if (firstVal === 'BEGIN' || (firstVal === 'START' && tokens[1]?.value === 'TRANSACTION')) {
        inExplicitTransaction = true;
        transactionStartLine = stmt.startLine;
        continue;
      }

      // Detect transaction end
      if (firstVal === 'COMMIT' || firstVal === 'ROLLBACK' || firstVal === 'END') {
        inExplicitTransaction = false;
        continue;
      }

      // Check if this statement is CREATE INDEX CONCURRENTLY or DROP INDEX CONCURRENTLY
      const isConcurrentIndexOp = isConcurrentIndexStatement(tokens);

      if (isConcurrentIndexOp) {
        if (stmt.hasIgnore(this.id)) continue;

        // Scenario 1: Inside an explicit transaction block
        if (inExplicitTransaction) {
          findings.push({
            ruleId: this.id,
            ruleName: this.name,
            severity: this.defaultSeverity,
            lockLevel: this.lockLevel,
            message: 'CONCURRENTLY index operation cannot run inside an explicit transaction block.',
            detail:
              `Statement at line ${stmt.startLine} is inside a transaction block started at line ${transactionStartLine}. ` +
              'PostgreSQL rejects concurrent index operations with "ERROR: CREATE/DROP INDEX CONCURRENTLY cannot run inside a transaction block".',
            suggestion: 'Remove the enclosing BEGIN ... COMMIT block and execute the CONCURRENTLY statement standalone.',
            file: context.filePath,
            line: stmt.startLine,
            column: stmt.startColumn,
            codeSnippet: stmt.raw,
          });
        }

        // Scenario 2: Prisma migration without -- prisma:no-transaction
        if (context.isPrismaMigration && !context.hasFilePrismaNoTransaction) {
          findings.push({
            ruleId: this.id,
            ruleName: this.name,
            severity: this.defaultSeverity,
            lockLevel: this.lockLevel,
            message: 'Concurrent index operation in Prisma migration requires "-- prisma:no-transaction".',
            detail:
              'Prisma Migrate executes every migration inside an implicit transaction block. ' +
              'Without the "-- prisma:no-transaction" directive, PostgreSQL will abort migration application.',
            suggestion: 'Add `-- prisma:no-transaction` at the very top of this migration file.',
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

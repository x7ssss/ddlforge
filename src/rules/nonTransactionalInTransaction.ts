/**
 * ddlforge Rule: Non-transactional statement inside a transaction block
 *
 * Rule ID: non-transactional-in-transaction
 * Severity: BLOCKER
 *
 * Fires when statements that require autocommit are found:
 *   - Inside an explicit BEGIN...COMMIT/ROLLBACK/END block, OR
 *   - In a Prisma migration file without the -- prisma-migrate-disable-next-transaction
 *     (or legacy -- prisma:no-transaction) pragma.
 *
 * Non-transactional statements covered:
 *   - CREATE INDEX CONCURRENTLY
 *   - DROP INDEX CONCURRENTLY
 *   - REINDEX CONCURRENTLY
 *   - VACUUM (any form)
 *   - ALTER TYPE ... ADD VALUE
 */

import { Rule, RuleContext, Finding } from './types.js';
import { PostgresLockLevel } from '../engine/locks.js';

interface NonTxStatement {
  label: string;  // human-readable description
}

/**
 * Identifies whether a statement is non-transactional and returns its label,
 * or null if it's a normal transactional statement.
 *
 * NOTE: CREATE/DROP INDEX CONCURRENTLY are intentionally excluded here because
 * they are already detected by the existing `concurrent-index-in-transaction`
 * (transactionTrapRule). This avoids duplicate findings for the same SQL.
 */
function getNonTransactionalLabel(tokens: Array<{ value: string; raw: string }>): NonTxStatement | null {
  if (tokens.length === 0) return null;

  const t0 = tokens[0].value;
  const t1 = tokens[1]?.value;

  // REINDEX CONCURRENTLY  (REINDEX [( options )] CONCURRENTLY ...)
  if (t0 === 'REINDEX') {
    for (let i = 1; i < tokens.length; i++) {
      if (tokens[i].value === 'CONCURRENTLY') {
        return { label: 'REINDEX CONCURRENTLY' };
      }
    }
  }

  // VACUUM (any form: VACUUM, VACUUM FULL, VACUUM ANALYZE, VACUUM FREEZE, etc.)
  if (t0 === 'VACUUM') {
    return { label: 'VACUUM' };
  }

  // ALTER TYPE ... ADD VALUE
  if (t0 === 'ALTER' && t1 === 'TYPE') {
    for (let i = 2; i < tokens.length - 1; i++) {
      if (tokens[i].value === 'ADD' && tokens[i + 1]?.value === 'VALUE') {
        return { label: 'ALTER TYPE ... ADD VALUE' };
      }
    }
  }

  return null;
}

/**
 * Checks whether the file content contains the Prisma disable-transaction pragma.
 * Prisma docs allow both:
 *   -- prisma-migrate-disable-next-transaction  (official)
 *   -- prisma:no-transaction                    (legacy / community)
 */
function hasPrismaDisableTransactionPragma(fileContent: string): boolean {
  return (
    fileContent.includes('prisma-migrate-disable-next-transaction') ||
    fileContent.includes('prisma:no-transaction')
  );
}

export const nonTransactionalInTransactionRule: Rule = {
  id: 'non-transactional-in-transaction',
  name: 'Non-transactional statement inside a transaction block',
  description:
    'Statements such as CREATE/DROP INDEX CONCURRENTLY, REINDEX CONCURRENTLY, VACUUM, and ALTER TYPE ... ADD VALUE ' +
    'cannot execute inside a transaction block (SQLSTATE 25001). They must run in autocommit mode.',
  defaultSeverity: 'BLOCKER',
  lockLevel: PostgresLockLevel.NONE,

  check(context: RuleContext): Finding[] {
    const findings: Finding[] = [];
    let inExplicitTransaction = false;
    let transactionStartLine = 1;

    // Determine if the Prisma pragma is present
    const prismaDisabled = hasPrismaDisableTransactionPragma(context.fileContent);

    for (const stmt of context.statements) {
      const tokens = stmt.tokens;
      if (tokens.length === 0) continue;

      const firstVal = tokens[0].value;

      // Track explicit transaction boundaries
      if (firstVal === 'BEGIN' || (firstVal === 'START' && tokens[1]?.value === 'TRANSACTION')) {
        inExplicitTransaction = true;
        transactionStartLine = stmt.startLine;
        continue;
      }
      if (firstVal === 'COMMIT' || firstVal === 'ROLLBACK' || firstVal === 'END') {
        inExplicitTransaction = false;
        continue;
      }

      const nonTx = getNonTransactionalLabel(tokens);
      if (!nonTx) continue;

      if (stmt.hasIgnore(this.id)) continue;

      // Scenario 1: Inside an explicit transaction block
      if (inExplicitTransaction) {
        findings.push({
          ruleId: this.id,
          ruleName: this.name,
          severity: this.defaultSeverity,
          lockLevel: this.lockLevel,
          message:
            `"${nonTx.label}" cannot run inside a transaction block (SQLSTATE 25001).`,
          detail:
            `Statement at line ${stmt.startLine} is wrapped in a transaction block started at line ${transactionStartLine}. ` +
            `PostgreSQL will abort with "ERROR: ${nonTx.label} cannot run inside a transaction block".`,
          suggestion:
            `Remove the enclosing BEGIN ... COMMIT block and run "${nonTx.label}" as a standalone autocommit statement.\n` +
            `If this is inside an ORM migration file, add the appropriate opt-out pragma:\n` +
            `  Prisma:  -- prisma-migrate-disable-next-transaction\n` +
            `  Flyway:  -- flyway:disableChecksum\n` +
            `  Generic: split into a separate non-transactional migration script.`,
          file: context.filePath,
          line: stmt.startLine,
          column: stmt.startColumn,
          codeSnippet: stmt.raw,
        });
      }

      // Scenario 2: Prisma migration without disable-transaction pragma
      if (context.isPrismaMigration && !prismaDisabled && !context.hasFilePrismaNoTransaction) {
        findings.push({
          ruleId: this.id,
          ruleName: this.name,
          severity: this.defaultSeverity,
          lockLevel: this.lockLevel,
          message:
            `"${nonTx.label}" in Prisma migration without -- prisma-migrate-disable-next-transaction.`,
          detail:
            `Prisma Migrate wraps every migration in an implicit transaction block by default. ` +
            `Without the opt-out pragma, PostgreSQL will abort with ` +
            `"ERROR: ${nonTx.label} cannot run inside a transaction block" (SQLSTATE 25001).`,
          suggestion:
            `Add the opt-out pragma at the top of the migration file:\n` +
            `   -- prisma-migrate-disable-next-transaction\n` +
            `Then isolate this statement to its own migration file.`,
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

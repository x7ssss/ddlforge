/**
 * ddlforge Rule: ALTER TYPE ... ADD VALUE inside transaction or referenced immediately
 *
 * Rule ID: enum-add-value-in-transaction
 * Severity: BLOCKER
 * Lock: ACCESS EXCLUSIVE
 */

import { Rule, RuleContext, Finding } from './types.js';
import { PostgresLockLevel } from '../engine/locks.js';
import { Statement } from '../lexer/tokens.js';

interface EnumAddValueInfo {
  enumName: string;
  newValue: string;
  statementIndex: number;
  stmt: Statement;
}

function extractEnumAddValue(stmt: Statement, index: number): EnumAddValueInfo | null {
  const tokens = stmt.tokens;
  if (tokens.length < 5) return null;

  if (tokens[0].value !== 'ALTER' || tokens[1].value !== 'TYPE') return null;

  let enumName = tokens[2]?.raw ?? 'enum_type';
  let i = 3;

  while (i < tokens.length) {
    if (tokens[i].value === 'ADD' && tokens[i + 1]?.value === 'VALUE') {
      let valIdx = i + 2;
      if (
        tokens[valIdx]?.value === 'IF' &&
        tokens[valIdx + 1]?.value === 'NOT' &&
        tokens[valIdx + 2]?.value === 'EXISTS'
      ) {
        valIdx += 3;
      }

      if (valIdx < tokens.length) {
        const rawVal = tokens[valIdx].raw;
        // Clean single quotes if string literal: 'value' -> value
        const cleanedVal = rawVal.replace(/^'|'$/g, '');
        return {
          enumName,
          newValue: cleanedVal,
          statementIndex: index,
          stmt,
        };
      }
    }
    i++;
  }

  return null;
}

export const enumAddValueInTransactionRule: Rule = {
  id: 'enum-add-value-in-transaction',
  name: 'ALTER TYPE ... ADD VALUE inside transaction or referenced immediately',
  description:
    'ALTER TYPE ... ADD VALUE cannot be executed inside a transaction block in PostgreSQL, and new enum values cannot be referenced within the same transaction or migration file.',
  defaultSeverity: 'BLOCKER',
  lockLevel: PostgresLockLevel.ACCESS_EXCLUSIVE,

  check(context: RuleContext): Finding[] {
    const findings: Finding[] = [];
    let inExplicitTransaction = false;

    for (let idx = 0; idx < context.statements.length; idx++) {
      const stmt = context.statements[idx];
      const tokens = stmt.tokens;
      if (tokens.length === 0) continue;

      const firstVal = tokens[0].value;

      // Track explicit transaction start
      if (firstVal === 'BEGIN' || (firstVal === 'START' && tokens[1]?.value === 'TRANSACTION')) {
        inExplicitTransaction = true;
        continue;
      }

      // Track explicit transaction end
      if (firstVal === 'COMMIT' || firstVal === 'ROLLBACK' || firstVal === 'END') {
        inExplicitTransaction = false;
        continue;
      }

      const enumInfo = extractEnumAddValue(stmt, idx);
      if (!enumInfo) continue;

      if (stmt.hasIgnore(this.id)) continue;

      // Check 1: Found inside an explicit transaction block
      if (inExplicitTransaction) {
        findings.push({
          ruleId: this.id,
          ruleName: this.name,
          severity: this.defaultSeverity,
          lockLevel: this.lockLevel,
          message: `ALTER TYPE "${enumInfo.enumName}" ADD VALUE '${enumInfo.newValue}' found inside an explicit transaction block.`,
          detail:
            `PostgreSQL does not allow ALTER TYPE ... ADD VALUE to run inside an existing transaction block ` +
            `(ERROR: ALTER TYPE ... ADD cannot run inside a transaction block).`,
          suggestion:
            `Move the ALTER TYPE statement outside the BEGIN ... COMMIT block into its own standalone migration file.`,
          file: context.filePath,
          line: stmt.startLine,
          column: stmt.startColumn,
          codeSnippet: stmt.raw,
        });
        continue;
      }

      // Check 2: Found in Prisma migration without -- prisma:no-transaction
      if (context.isPrismaMigration && !context.hasFilePrismaNoTransaction) {
        findings.push({
          ruleId: this.id,
          ruleName: this.name,
          severity: this.defaultSeverity,
          lockLevel: this.lockLevel,
          message: `ALTER TYPE "${enumInfo.enumName}" ADD VALUE '${enumInfo.newValue}' in Prisma migration without -- prisma:no-transaction.`,
          detail:
            `Prisma wraps each migration in a transaction block by default, causing PostgreSQL to abort ` +
            `with "ERROR: ALTER TYPE ... ADD cannot run inside a transaction block".`,
          suggestion:
            `Add "-- prisma:no-transaction" directive at the top of the migration file:
-- prisma:no-transaction
ALTER TYPE ${enumInfo.enumName} ADD VALUE '${enumInfo.newValue}';`,
          file: context.filePath,
          line: stmt.startLine,
          column: stmt.startColumn,
          codeSnippet: stmt.raw,
        });
        continue;
      }

      // Check 3: Check if a subsequent statement in the same file references the new enum value
      let referencedInLaterStatement = false;
      let referencingStmt: Statement | null = null;

      for (let subsequentIdx = idx + 1; subsequentIdx < context.statements.length; subsequentIdx++) {
        const subStmt = context.statements[subsequentIdx];
        const subRaw = subStmt.raw;

        // Check if subsequent statement references the new value (e.g. 'new_val' or identifier new_val)
        const matchesLiteral = subRaw.includes(`'${enumInfo.newValue}'`);
        const matchesIdent = subStmt.tokens.some(
          t => t.value === enumInfo.newValue.toUpperCase() || t.raw === enumInfo.newValue
        );

        if (matchesLiteral || matchesIdent) {
          referencedInLaterStatement = true;
          referencingStmt = subStmt;
          break;
        }
      }

      if (referencedInLaterStatement && referencingStmt) {
        findings.push({
          ruleId: this.id,
          ruleName: this.name,
          severity: this.defaultSeverity,
          lockLevel: this.lockLevel,
          message: `New enum value '${enumInfo.newValue}' of type "${enumInfo.enumName}" is referenced in subsequent statement within the same file (Line ${referencingStmt.startLine}).`,
          detail:
            `PostgreSQL raises "ERROR: unsafe use of new value \\"${enumInfo.newValue}\\" of enum type" ` +
            `when a newly added enum value is referenced in the same transaction or migration file where it was created.`,
          suggestion:
            `Split into two migrations:\n` +
            `1. Migration 1: Add the enum value:\n` +
            `   ALTER TYPE ${enumInfo.enumName} ADD VALUE '${enumInfo.newValue}';\n` +
            `2. Migration 2: Use the new enum value in subsequent queries/defaults.`,
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

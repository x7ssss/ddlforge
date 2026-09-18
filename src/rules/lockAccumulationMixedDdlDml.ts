/**
 * ddlforge Rule: Lock accumulation from mixed DDL + DML in the same transaction
 *
 * Rule ID: lock-accumulation-mixed-ddl-dml
 * Severity: BLOCKER
 * Lock: ACCESS EXCLUSIVE (from the DDL statement)
 *
 * Fires when a single migration file or explicit transaction block contains:
 *   - An ALTER TABLE statement (which acquires AccessExclusiveLock), followed by
 *   - An UPDATE, INSERT, or DELETE statement
 *
 * Hazard: Locks acquired by the DDL are held for the entire duration of the
 * transaction, including through the subsequent DML backfill, starving connection
 * pools and blocking all reads/writes for potentially minutes or hours.
 *
 * Recipe: Split DDL and DML into separate phases/transactions.
 */

import { Rule, RuleContext, Finding } from './types.js';
import { PostgresLockLevel } from '../engine/locks.js';
import { Statement } from '../lexer/tokens.js';

interface DdlInfo {
  tableName: string;
  stmtIdx: number;
  stmt: Statement;
}

interface DmlInfo {
  operation: 'UPDATE' | 'INSERT' | 'DELETE';
  tableName: string;
  stmtIdx: number;
  stmt: Statement;
}

function extractAlterTableName(tokens: Array<{ value: string; raw: string }>): string | null {
  if (tokens[0]?.value !== 'ALTER' || tokens[1]?.value !== 'TABLE') return null;

  let idx = 2;
  // Skip IF EXISTS, ONLY
  while (idx < tokens.length) {
    if (tokens[idx]?.value === 'IF' && tokens[idx + 1]?.value === 'EXISTS') { idx += 2; continue; }
    if (tokens[idx]?.value === 'ONLY') { idx++; continue; }
    break;
  }

  // Collect table name
  const parts: string[] = [];
  if (idx < tokens.length) {
    parts.push(tokens[idx].raw);
    idx++;
    while (idx < tokens.length && tokens[idx]?.value === '.') {
      parts.push('.');
      idx++;
      if (idx < tokens.length) { parts.push(tokens[idx].raw); idx++; }
    }
  }
  return parts.join('') || null;
}

function extractDmlInfo(tokens: Array<{ value: string; raw: string }>): { op: 'UPDATE' | 'INSERT' | 'DELETE'; table: string } | null {
  const t0 = tokens[0]?.value;

  if (t0 === 'UPDATE') {
    // UPDATE [ONLY] <table>
    let idx = 1;
    if (tokens[idx]?.value === 'ONLY') idx++;
    return { op: 'UPDATE', table: tokens[idx]?.raw ?? 'table' };
  }

  if (t0 === 'INSERT' && tokens[1]?.value === 'INTO') {
    return { op: 'INSERT', table: tokens[2]?.raw ?? 'table' };
  }

  if (t0 === 'DELETE' && tokens[1]?.value === 'FROM') {
    let idx = 2;
    if (tokens[idx]?.value === 'ONLY') idx++;
    return { op: 'DELETE', table: tokens[idx]?.raw ?? 'table' };
  }

  return null;
}

/**
 * Analyzes a contiguous group of statements (either explicit tx block or full file)
 * and returns findings for DDL followed by DML.
 */
function analyzeScope(
  stmts: Array<{ ddl?: DdlInfo; dml?: DmlInfo; stmt: Statement; idx: number }>,
  filePath: string,
  scopeLabel: string,
): Finding[] {
  const findings: Finding[] = [];
  const ddls: DdlInfo[] = [];
  const dmls: DmlInfo[] = [];

  for (const item of stmts) {
    if (item.ddl) ddls.push(item.ddl);
    if (item.dml) dmls.push(item.dml);
  }

  for (const ddl of ddls) {
    const followingDml = dmls.filter(d => d.stmtIdx > ddl.stmtIdx);
    for (const dml of followingDml) {
      if (dml.stmt.hasIgnore(lockAccumulationMixedDdlDmlRule.id)) continue;
      if (ddl.stmt.hasIgnore(lockAccumulationMixedDdlDmlRule.id)) continue;
      findings.push(buildFinding(ddl, dml, filePath, scopeLabel));
    }
  }
  return findings;
}

export const lockAccumulationMixedDdlDmlRule: Rule = {
  id: 'lock-accumulation-mixed-ddl-dml',
  name: 'Lock accumulation from mixed DDL and DML in the same transaction',
  description:
    'Mixing ALTER TABLE (AccessExclusiveLock) with UPDATE/INSERT/DELETE in the same transaction or migration ' +
    'file causes the DDL lock to be held for the entire duration of the DML phase, starving connection pools ' +
    'and blocking all reads and writes for potentially minutes or hours.',
  defaultSeverity: 'BLOCKER',
  lockLevel: PostgresLockLevel.ACCESS_EXCLUSIVE,

  check(context: RuleContext): Finding[] {
    const findings: Finding[] = [];

    // Single-pass approach:
    // - Partition statements into scopes: explicit tx blocks get their own scope,
    //   statements outside any explicit tx are collected into an "implicit" file scope.
    // - Each scope is analyzed independently so there's no double-counting.

    type ScopeItem = { ddl?: DdlInfo; dml?: DmlInfo; stmt: Statement; idx: number };

    const fileScope: ScopeItem[] = [];        // statements outside any explicit tx
    let txScope: ScopeItem[] = [];            // statements inside current explicit tx
    let inExplicitTx = false;

    for (let i = 0; i < context.statements.length; i++) {
      const stmt = context.statements[i];
      const tokens = stmt.tokens;
      if (tokens.length === 0) continue;

      const t0 = tokens[0].value;

      if (t0 === 'BEGIN' || (t0 === 'START' && tokens[1]?.value === 'TRANSACTION')) {
        inExplicitTx = true;
        txScope = [];
        continue;
      }

      if (t0 === 'COMMIT' || t0 === 'ROLLBACK' || t0 === 'END') {
        if (inExplicitTx) {
          // Analyze the explicit transaction scope
          findings.push(...analyzeScope(txScope, context.filePath, 'explicit transaction block'));
        }
        inExplicitTx = false;
        txScope = [];
        continue;
      }

      // Classify this statement
      const alterTable = extractAlterTableName(tokens);
      const dmlInfo = extractDmlInfo(tokens);

      const item: ScopeItem = { stmt, idx: i };
      if (alterTable !== null) item.ddl = { tableName: alterTable, stmtIdx: i, stmt };
      if (dmlInfo !== null) item.dml = { operation: dmlInfo.op, tableName: dmlInfo.table, stmtIdx: i, stmt };

      if (inExplicitTx) {
        txScope.push(item);
      } else {
        fileScope.push(item);
      }
    }

    // Analyze the implicit file scope (statements outside explicit transactions)
    findings.push(...analyzeScope(fileScope, context.filePath, 'migration file (implicit transaction)'));

    return findings;
  },
};

function buildFinding(
  ddl: DdlInfo,
  dml: DmlInfo,
  filePath: string,
  scope: string,
): import('./types.js').Finding {
  return {
    ruleId: lockAccumulationMixedDdlDmlRule.id,
    ruleName: lockAccumulationMixedDdlDmlRule.name,
    severity: lockAccumulationMixedDdlDmlRule.defaultSeverity,
    lockLevel: lockAccumulationMixedDdlDmlRule.lockLevel,
    message:
      `ALTER TABLE on "${ddl.tableName}" (line ${ddl.stmt.startLine}) holds AccessExclusiveLock through ` +
      `${dml.operation} on "${dml.tableName}" (line ${dml.stmt.startLine}) in the same ${scope}.`,
    detail:
      `When an ALTER TABLE acquires AccessExclusiveLock and is followed by a DML statement ` +
      `(${dml.operation}) in the same transaction or migration, the lock is held for the entire ` +
      `duration of the DML operation — which may process millions of rows — starving the connection ` +
      `pool and blocking all concurrent reads and writes on "${ddl.tableName}".`,
    suggestion:
      `Split DDL and DML into separate phases:\n` +
      `  Phase 1 (DDL, fast lock): Run ALTER TABLE in isolation.\n` +
      `     ALTER TABLE ${ddl.tableName} ...;\n` +
      `  Phase 2 (DML, background): Run ${dml.operation} in small batched transactions (1000–5000 rows).\n` +
      `     -- Process batches asynchronously via a background job or migration with LIMIT + OFFSET.`,
    file: filePath,
    line: dml.stmt.startLine,
    column: dml.stmt.startColumn,
    codeSnippet: dml.stmt.raw,
  };
}

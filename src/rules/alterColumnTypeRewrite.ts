/**
 * ddlforge Rule: ALTER COLUMN TYPE requiring table rewrite
 *
 * Severity: BLOCKER
 * Lock: ACCESS EXCLUSIVE
 *
 * Fires whenever ALTER TABLE ... ALTER COLUMN ... [SET DATA] TYPE is detected,
 * because we cannot statically determine whether the type change is safe
 * (metadata-only) or requires a full table rewrite — we always flag it.
 */

import { Rule, RuleContext, Finding } from './types.js';
import { PostgresLockLevel } from '../engine/locks.js';
import { Statement, Token } from '../lexer/tokens.js';

interface AlterColumnTypeClause {
  colName: string;
  newType: string;
}

interface ColumnTypeInfo {
  baseType: string;
  length?: number;
  precision?: number;
  scale?: number;
  raw: string;
}

function parseColumnType(rawType: string): ColumnTypeInfo | null {
  const norm = rawType.trim().toLowerCase().replace(/\s+/g, ' ');
  // varchar(X) or character varying(X)
  const varcharMatch = norm.match(/^(?:varchar|character\s+varying)\s*\(\s*(\d+)\s*\)$/);
  if (varcharMatch) {
    return { baseType: 'varchar', length: parseInt(varcharMatch[1], 10), raw: rawType };
  }
  // unbounded varchar
  if (norm === 'varchar' || norm === 'character varying') {
    return { baseType: 'varchar', length: Infinity, raw: rawType };
  }
  // text
  if (norm === 'text') {
    return { baseType: 'text', raw: rawType };
  }
  // numeric(p, s) or decimal(p, s)
  const numMatch = norm.match(/^(?:numeric|decimal)\s*\(\s*(\d+)(?:\s*,\s*(\d+))?\s*\)$/);
  if (numMatch) {
    return {
      baseType: 'numeric',
      precision: parseInt(numMatch[1], 10),
      scale: numMatch[2] ? parseInt(numMatch[2], 10) : 0,
      raw: rawType,
    };
  }
  if (norm === 'numeric' || norm === 'decimal') {
    return { baseType: 'numeric', raw: rawType };
  }
  if (norm === 'int' || norm === 'integer' || norm === 'int4') {
    return { baseType: 'integer', raw: rawType };
  }
  if (norm === 'bigint' || norm === 'int8') {
    return { baseType: 'bigint', raw: rawType };
  }
  return { baseType: norm, raw: rawType };
}

function isMetadataOnlySafe(oldType: ColumnTypeInfo, newType: ColumnTypeInfo): boolean {
  // 1. varchar(X) -> varchar(Y) where Y >= X, or varchar(X) -> unbounded varchar
  if (oldType.baseType === 'varchar' && newType.baseType === 'varchar') {
    const oldLen = oldType.length ?? Infinity;
    const newLen = newType.length ?? Infinity;
    return newLen >= oldLen;
  }
  // 2. varchar(X) -> text (PostgreSQL 9.1+ is binary-compatible catalog update)
  if (oldType.baseType === 'varchar' && newType.baseType === 'text') {
    return true;
  }
  // 3. text -> unbounded varchar
  if (oldType.baseType === 'text' && newType.baseType === 'varchar' && (newType.length === undefined || newType.length === Infinity)) {
    return true;
  }
  // 4. numeric(p1, s) -> numeric(p2, s) where p2 >= p1 and scale is identical (PG 9.2+)
  if (oldType.baseType === 'numeric' && newType.baseType === 'numeric') {
    if (oldType.scale !== undefined && newType.scale !== undefined && oldType.scale === newType.scale) {
      if (oldType.precision !== undefined && newType.precision !== undefined) {
        return newType.precision >= oldType.precision;
      }
    }
    // numeric(p, s) -> unconstrained numeric (removes precision limit without rewrite in PG 9.2+)
    if (oldType.precision !== undefined && newType.precision === undefined) {
      return true;
    }
  }
  return false;
}

function extractOldTypeFromComments(comments: string[]): string | undefined {
  for (const comment of comments) {
    const mArrow = comment.match(/([a-zA-Z0-9_]+(?:\s*\(\s*\d+(?:\s*,\s*\d+)?\s*\))?)\s*(?:->|to)\s*([a-zA-Z0-9_]+(?:\s*\(\s*\d+(?:\s*,\s*\d+)?\s*\))?)/i);
    if (mArrow) {
      return mArrow[1].trim();
    }
    const mWas = comment.match(/(?:from|was|old(?:_type|-type)?|previous)\s*[:=]?\s*([a-zA-Z0-9_]+(?:\s*\(\s*\d+(?:\s*,\s*\d+)?\s*\))?)/i);
    if (mWas) {
      return mWas[1].trim();
    }
  }
  return undefined;
}

function buildSchemaMap(statements: Statement[]): Map<string, Map<string, string>> {
  const schema = new Map<string, Map<string, string>>();

  function setCol(table: string, col: string, type: string) {
    const t = table.toLowerCase().replace(/["']/g, '');
    const c = col.toLowerCase().replace(/["']/g, '');
    if (!schema.has(t)) schema.set(t, new Map());
    schema.get(t)!.set(c, type);
  }

  function processColDef(tableName: string, colTokens: Token[]) {
    if (colTokens.length < 2) return;
    const firstUpper = colTokens[0].value;
    if (['CONSTRAINT', 'PRIMARY', 'FOREIGN', 'CHECK', 'UNIQUE'].includes(firstUpper)) {
      return;
    }
    const colName = colTokens[0].raw;
    const typeParts: string[] = [];
    let pDepth = 0;
    for (let i = 1; i < colTokens.length; i++) {
      const tok = colTokens[i];
      if (tok.value === '(') pDepth++;
      if (tok.value === ')') pDepth--;
      if (pDepth === 0 && ['DEFAULT', 'NOT', 'NULL', 'PRIMARY', 'REFERENCES', 'CHECK', 'UNIQUE', 'CONSTRAINT'].includes(tok.value)) {
        break;
      }
      typeParts.push(tok.raw);
    }
    if (typeParts.length > 0) {
      setCol(tableName, colName, typeParts.join(' '));
    }
  }

  for (const stmt of statements) {
    const tokens = stmt.tokens;
    if (tokens.length < 3) continue;

    // CREATE TABLE [IF NOT EXISTS] <table> (...)
    if (tokens[0].value === 'CREATE' && tokens[1].value === 'TABLE') {
      let idx = 2;
      if (tokens[idx]?.value === 'IF' && tokens[idx + 1]?.value === 'NOT' && tokens[idx + 2]?.value === 'EXISTS') {
        idx += 3;
      }
      const tableName = tokens[idx]?.raw;
      if (!tableName) continue;
      idx++;

      if (tokens[idx]?.value !== '(') continue;
      idx++;

      let parenDepth = 1;
      let colTokens: Token[] = [];

      while (idx < tokens.length && parenDepth > 0) {
        const t = tokens[idx];
        if (t.value === '(') {
          parenDepth++;
          colTokens.push(t);
        } else if (t.value === ')') {
          parenDepth--;
          if (parenDepth > 0) colTokens.push(t);
        } else if (t.value === ',' && parenDepth === 1) {
          processColDef(tableName, colTokens);
          colTokens = [];
        } else {
          colTokens.push(t);
        }
        idx++;
      }
      if (colTokens.length > 0) {
        processColDef(tableName, colTokens);
      }
    }

    // ALTER TABLE <table> ADD [COLUMN] <col> <type>
    if (tokens[0].value === 'ALTER' && tokens[1].value === 'TABLE') {
      let idx = 2;
      if (tokens[idx]?.value === 'ONLY') idx++;
      if (tokens[idx]?.value === 'IF' && tokens[idx + 1]?.value === 'EXISTS') idx += 2;
      const tableName = tokens[idx]?.raw;
      if (!tableName) continue;
      idx++;

      let parenDepth = 0;
      while (idx < tokens.length) {
        if (tokens[idx].value === '(') parenDepth++;
        if (tokens[idx].value === ')') parenDepth--;

        if (parenDepth === 0 && tokens[idx].value === 'ADD') {
          let cur = idx + 1;
          if (tokens[cur]?.value === 'COLUMN') cur++;
          if (tokens[cur]?.value === 'IF' && tokens[cur + 1]?.value === 'NOT' && tokens[cur + 2]?.value === 'EXISTS') cur += 3;
          if (tokens[cur]?.value !== 'CONSTRAINT' && tokens[cur]?.value !== 'PRIMARY' && tokens[cur]?.value !== 'FOREIGN' && tokens[cur]?.value !== 'CHECK' && tokens[cur]?.value !== 'UNIQUE') {
            const colName = tokens[cur]?.raw;
            cur++;
            if (colName && cur < tokens.length) {
              const typeParts: string[] = [];
              let typeParen = 0;
              while (cur < tokens.length) {
                const ct = tokens[cur];
                if (ct.value === '(') typeParen++;
                if (ct.value === ')') typeParen--;
                if (typeParen === 0 && (ct.value === ',' || ct.value === ';' || ct.value === 'DEFAULT' || ct.value === 'NOT' || ct.value === 'NULL' || ct.value === 'CHECK' || ct.value === 'REFERENCES' || ct.value === 'CONSTRAINT')) {
                  break;
                }
                typeParts.push(ct.raw);
                cur++;
              }
              if (typeParts.length > 0) {
                setCol(tableName, colName, typeParts.join(' '));
              }
            }
          }
        }
        idx++;
      }
    }
  }

  return schema;
}

/**
 * Given the tokens *after* the table name, scan for all sub-ALTER clauses
 * that contain a TYPE keyword (i.e. ALTER [COLUMN] <col> [SET DATA] TYPE ...).
 */
function extractAlterColumnTypeClauses(tokens: Token[]): AlterColumnTypeClause[] {
  const clauses: AlterColumnTypeClause[] = [];
  let parenDepth = 0;
  let i = 0;

  while (i < tokens.length) {
    if (tokens[i].value === '(') {
      parenDepth++;
      i++;
      continue;
    }
    if (tokens[i].value === ')') {
      parenDepth--;
      i++;
      continue;
    }

    // Look for top-level ALTER (the sub-command ALTER COLUMN ...)
    if (parenDepth === 0 && tokens[i].value === 'ALTER') {
      let cur = i + 1;

      // Skip optional COLUMN keyword
      if (tokens[cur]?.value === 'COLUMN') cur++;

      // Skip optional IF EXISTS on column
      if (tokens[cur]?.value === 'IF' && tokens[cur + 1]?.value === 'EXISTS') cur += 2;

      // Column name
      const colName = tokens[cur]?.raw;
      if (!colName) {
        i++;
        continue;
      }
      cur++;

      // Check for [SET DATA] TYPE
      let hasType = false;
      if (tokens[cur]?.value === 'SET' && tokens[cur + 1]?.value === 'DATA' && tokens[cur + 2]?.value === 'TYPE') {
        cur += 3;
        hasType = true;
      } else if (tokens[cur]?.value === 'TYPE') {
        cur++;
        hasType = true;
      }

      if (hasType) {
        // Collect the new type tokens until a top-level comma, semicolon, or end
        const typeTokens: string[] = [];
        let subParen = 0;

        while (cur < tokens.length) {
          const t = tokens[cur];
          if (t.value === '(') subParen++;
          if (t.value === ')') subParen--;
          if (subParen === 0 && (t.value === ',' || t.value === ';')) break;
          // Stop at top-level USING clause (it's not part of the type name)
          if (subParen === 0 && t.value === 'USING') break;
          typeTokens.push(t.raw);
          cur++;
        }

        clauses.push({ colName, newType: typeTokens.join(' ') });
        i = cur;
        continue;
      }
    }

    i++;
  }

  return clauses;
}

export const alterColumnTypeRewriteRule: Rule = {
  id: 'alter-column-type-rewrite',
  name: 'ALTER COLUMN TYPE requiring table rewrite',
  description:
    'ALTER TABLE ... ALTER COLUMN ... TYPE performs a full table rewrite under ACCESS EXCLUSIVE lock in most cases, blocking all reads and writes for the duration of the operation.',
  defaultSeverity: 'BLOCKER',
  lockLevel: PostgresLockLevel.ACCESS_EXCLUSIVE,

  check(context: RuleContext): Finding[] {
    const findings: Finding[] = [];
    const schemaMap = buildSchemaMap(context.statements);

    for (const stmt of context.statements) {
      if (stmt.hasIgnore(this.id)) continue;

      const tokens = stmt.tokens;
      if (tokens.length < 6) continue;

      if (tokens[0].value !== 'ALTER' || tokens[1].value !== 'TABLE') continue;

      // Extract table name, honouring IF EXISTS and ONLY modifiers
      let idx = 2;
      if (tokens[idx]?.value === 'ONLY') idx++;
      if (tokens[idx]?.value === 'IF' && tokens[idx + 1]?.value === 'EXISTS') idx += 2;
      const tableName = tokens[idx]?.raw ?? 'table';
      idx++;

      const clauses = extractAlterColumnTypeClauses(tokens.slice(idx));

      for (const clause of clauses) {
        // Try to determine old type from schema or comments
        const cleanTable = tableName.toLowerCase().replace(/["']/g, '');
        const cleanCol = clause.colName.toLowerCase().replace(/["']/g, '');
        const oldTypeFromSchema = schemaMap.get(cleanTable)?.get(cleanCol);
        const oldTypeFromComment = extractOldTypeFromComments(stmt.comments);
        const oldTypeStr = oldTypeFromSchema || oldTypeFromComment;

        let isSafe = false;
        if (oldTypeStr) {
          const oldInfo = parseColumnType(oldTypeStr);
          const newInfo = parseColumnType(clause.newType);
          if (oldInfo && newInfo && isMetadataOnlySafe(oldInfo, newInfo)) {
            isSafe = true;
          }
        }

        if (isSafe) {
          findings.push({
            ruleId: this.id,
            ruleName: this.name,
            severity: 'WARNING',
            lockLevel: PostgresLockLevel.ACCESS_EXCLUSIVE,
            message: `Column "${clause.colName}" on table "${tableName}" type altered from ${oldTypeStr} to ${clause.newType} (metadata-only catalog update, no table rewrite).`,
            detail:
              `Increasing varchar length (or converting to unbounded text) is metadata-only in PostgreSQL 9.2+ and does not rewrite table data, ` +
              `but still acquires an ACCESS EXCLUSIVE lock during catalog update.`,
            suggestion:
              `Safe metadata-only operation: no table rewrite required. Ensure this runs with a short lock_timeout to avoid lock queues.`,
            file: context.filePath,
            line: stmt.startLine,
            column: stmt.startColumn,
            codeSnippet: stmt.raw,
          });
        } else {
          findings.push({
            ruleId: this.id,
            ruleName: this.name,
            severity: this.defaultSeverity,
            lockLevel: this.lockLevel,
            message: `Column "${clause.colName}" on table "${tableName}" has its type changed via ALTER COLUMN TYPE.`,
            detail:
              `ALTER TABLE ... ALTER COLUMN ... TYPE performs a full table rewrite under ACCESS EXCLUSIVE lock in most cases, ` +
              `blocking all reads and writes for the duration of the operation.`,
            suggestion:
              `1. Add a new column with the target type:\n` +
              `   ALTER TABLE ${tableName} ADD COLUMN ${clause.colName}_new ${clause.newType || '<new_type>'};\n` +
              `2. Backfill in batches (avoid unbatched UPDATE).\n` +
              `3. Swap column names in a single transaction:\n` +
              `   BEGIN;\n` +
              `   ALTER TABLE ${tableName} RENAME COLUMN ${clause.colName} TO ${clause.colName}_old;\n` +
              `   ALTER TABLE ${tableName} RENAME COLUMN ${clause.colName}_new TO ${clause.colName};\n` +
              `   COMMIT;\n` +
              `4. Drop the old column after verifying correctness:\n` +
              `   ALTER TABLE ${tableName} DROP COLUMN ${clause.colName}_old;`,
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

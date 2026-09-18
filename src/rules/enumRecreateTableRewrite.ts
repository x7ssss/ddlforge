/**
 * ddlforge Rule: Enum recreate + ALTER COLUMN TYPE causes full table rewrite
 *
 * Rule ID: enum-recreate-table-rewrite
 * Severity: BLOCKER
 * Lock: ACCESS EXCLUSIVE
 *
 * Fires when an ALTER TABLE ... ALTER COLUMN ... TYPE ... USING col::text::<type>
 * (or similar USING cast) is present in a file that also contains a DROP TYPE /
 * CREATE TYPE pattern for an enum — indicating an enum was recreated and the
 * column is being recast, which forces a full physical table rewrite.
 *
 * In PostgreSQL 16+ the preferred approach is ALTER TYPE ... RENAME VALUE.
 */

import { Rule, RuleContext, Finding } from './types.js';
import { PostgresLockLevel } from '../engine/locks.js';
import { Statement } from '../lexer/tokens.js';

/**
 * Returns true if the statement is a DROP TYPE statement.
 */
function isDropType(tokens: Array<{ value: string; raw: string }>): string | null {
  if (tokens[0]?.value === 'DROP' && tokens[1]?.value === 'TYPE') {
    // find the type name
    let idx = 2;
    if (tokens[idx]?.value === 'IF' && tokens[idx + 1]?.value === 'EXISTS') idx += 2;
    return tokens[idx]?.raw?.toLowerCase().replace(/^"|"$/g, '') ?? null;
  }
  return null;
}

/**
 * Returns true if the statement is a CREATE TYPE ... AS ENUM statement.
 */
function isCreateTypeEnum(tokens: Array<{ value: string; raw: string }>): string | null {
  if (tokens[0]?.value === 'CREATE' && tokens[1]?.value === 'TYPE') {
    let idx = 2;
    // Collect type name
    const typeName = tokens[idx]?.raw?.toLowerCase().replace(/^"|"$/g, '') ?? null;
    if (!typeName) return null;
    // Look for AS ENUM
    for (let i = idx + 1; i < tokens.length - 1; i++) {
      if (tokens[i].value === 'AS' && tokens[i + 1]?.value === 'ENUM') {
        return typeName;
      }
    }
  }
  return null;
}

/**
 * Detects if an ALTER TABLE ... ALTER COLUMN ... TYPE uses a USING clause
 * that performs a text cast (e.g., col::text::new_enum or CAST(col AS text)::new_enum),
 * which is the hallmark of an enum recreation rewrite pattern.
 */
interface EnumRewriteClause {
  tableName: string;
  colName: string;
  newType: string;
  hasCastUsing: boolean;
}

function extractEnumTypeRewriteClauses(
  stmt: Statement,
): EnumRewriteClause | null {
  const tokens = stmt.tokens;
  if (tokens.length < 6) return null;
  if (tokens[0].value !== 'ALTER' || tokens[1].value !== 'TABLE') return null;

  // Skip modifiers before table name
  let idx = 2;
  while (idx < tokens.length) {
    if (tokens[idx]?.value === 'IF' && tokens[idx + 1]?.value === 'EXISTS') { idx += 2; continue; }
    if (tokens[idx]?.value === 'ONLY') { idx++; continue; }
    break;
  }

  // Collect table name
  const tableParts: string[] = [];
  if (idx < tokens.length) {
    tableParts.push(tokens[idx].raw);
    idx++;
    while (idx < tokens.length && tokens[idx]?.value === '.') {
      tableParts.push('.'); idx++;
      if (idx < tokens.length) { tableParts.push(tokens[idx].raw); idx++; }
    }
  }
  const tableName = tableParts.join('') || 'table';

  // Scan for ALTER [COLUMN] <col> [SET DATA] TYPE <type> USING
  while (idx < tokens.length) {
    if (tokens[idx]?.value === 'ALTER') {
      let cur = idx + 1;
      if (tokens[cur]?.value === 'COLUMN') cur++;
      if (tokens[cur]?.value === 'IF' && tokens[cur + 1]?.value === 'EXISTS') cur += 2;

      const colName = tokens[cur]?.raw;
      if (!colName) { idx++; continue; }
      cur++;

      let hasType = false;
      if (tokens[cur]?.value === 'SET' && tokens[cur + 1]?.value === 'DATA' && tokens[cur + 2]?.value === 'TYPE') {
        cur += 3; hasType = true;
      } else if (tokens[cur]?.value === 'TYPE') {
        cur++; hasType = true;
      }

      if (hasType) {
        // Collect new type
        const typeTokens: string[] = [];
        let subParen = 0;
        while (cur < tokens.length) {
          const t = tokens[cur];
          if (t.value === '(') subParen++;
          if (t.value === ')') subParen--;
          if (subParen === 0 && (t.value === ',' || t.value === ';')) break;
          if (subParen === 0 && t.value === 'USING') break;
          typeTokens.push(t.raw);
          cur++;
        }
        const newType = typeTokens.join(' ').trim();

        // Check for USING clause
        let hasCastUsing = false;
        if (tokens[cur]?.value === 'USING') {
          cur++;
          // Collect the USING expression and look for ::text or CAST(... AS text)
          const usingTokens: string[] = [];
          let uparen = 0;
          while (cur < tokens.length) {
            const t = tokens[cur];
            if (t.value === '(') uparen++;
            if (t.value === ')') uparen--;
            if (uparen === 0 && (t.value === ',' || t.value === ';')) break;
            usingTokens.push(t.raw);
            cur++;
          }
          // The :: operator is tokenized separately, so join without spaces for pattern matching
          const usingExprSpaced = usingTokens.join(' ').toLowerCase();
          const usingExprCompact = usingTokens.join('').toLowerCase();
          // Common patterns: col::text::new_enum, cast(col as text)::new_enum, col::varchar::new_enum
          // After tokenization: tokens are ['col', '::', 'text', '::', 'new_enum']
          // joined with ' ' = 'col :: text :: new_enum' (no '::text' substring)
          // joined with '' = 'col::text::new_enum' (has '::text' substring)
          if (
            usingExprCompact.includes('::text') ||
            usingExprCompact.includes('::varchar') ||
            usingExprSpaced.includes('as text') ||
            usingExprSpaced.includes('as varchar')
          ) {
            hasCastUsing = true;
          }
        }

        if (hasCastUsing) {
          return { tableName, colName, newType, hasCastUsing };
        }
      }
    }
    idx++;
  }

  return null;
}

export const enumRecreateTableRewriteRule: Rule = {
  id: 'enum-recreate-table-rewrite',
  name: 'Enum recreation causes full table rewrite via ALTER COLUMN TYPE',
  description:
    'Dropping and recreating an enum type, then recasting a column to the new type via a text-cast USING ' +
    'expression, forces PostgreSQL to perform a full physical table rewrite under AccessExclusiveLock.',
  defaultSeverity: 'BLOCKER',
  lockLevel: PostgresLockLevel.ACCESS_EXCLUSIVE,

  check(context: RuleContext): Finding[] {
    const findings: Finding[] = [];

    // First pass: collect all enum types that were dropped or recreated in this migration
    const droppedEnums = new Set<string>();
    const createdEnums = new Set<string>();

    for (const stmt of context.statements) {
      const tokens = stmt.tokens;
      if (tokens.length < 3) continue;

      const dropped = isDropType(tokens);
      if (dropped) droppedEnums.add(dropped);

      const created = isCreateTypeEnum(tokens);
      if (created) createdEnums.add(created);
    }

    // The recreation pattern: same type is both dropped and re-created as ENUM in the same file
    const recreatedEnums = new Set<string>();
    for (const t of droppedEnums) {
      if (createdEnums.has(t)) recreatedEnums.add(t);
    }

    // Second pass: look for ALTER TABLE ... ALTER COLUMN TYPE with USING ::text cast
    for (const stmt of context.statements) {
      if (stmt.hasIgnore(this.id)) continue;

      const clause = extractEnumTypeRewriteClauses(stmt);
      if (!clause) continue;

      // We fire if:
      // (a) recreated enums exist in this file (classic enum recreate pattern), OR
      // (b) the USING expression explicitly does a text cast (dead giveaway regardless)
      const hasRecreate = recreatedEnums.size > 0;

      if (hasRecreate && clause.hasCastUsing) {
        const pgVersionNote =
          context.pgVersion >= 16
            ? `In PostgreSQL ${context.pgVersion} use ALTER TYPE ... RENAME VALUE to rename enum labels without a table rewrite.`
            : `In PostgreSQL < 16, avoid renaming enum values by enforcing the restriction in the application layer instead.`;

        findings.push({
          ruleId: this.id,
          ruleName: this.name,
          severity: this.defaultSeverity,
          lockLevel: this.lockLevel,
          message:
            `Column "${clause.colName}" on table "${clause.tableName}" recast to recreated enum type "${clause.newType}" via text cast, causing a full table rewrite.`,
          detail:
            `This migration drops and re-creates an enum type (${Array.from(recreatedEnums).join(', ')}), ` +
            `then recasts the column using a ::text intermediate cast. PostgreSQL must rewrite every row ` +
            `in "${clause.tableName}" under AccessExclusiveLock to apply the new physical storage format.`,
          suggestion:
            `${pgVersionNote}\n\n` +
            `If you must rename an enum value in PG16+:\n` +
            `   ALTER TYPE ${clause.newType} RENAME VALUE 'old_label' TO 'new_label';\n\n` +
            `If you must add/remove labels in older PG:\n` +
            `  1. Add new label (safe, no rewrite):\n` +
            `     ALTER TYPE <enum_name> ADD VALUE 'new_label';\n` +
            `  2. Migrate column data in batches.\n` +
            `  3. Remove old label by enforcing application-layer restrictions (not supported by ALTER TYPE directly).`,
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

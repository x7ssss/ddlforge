/**
 * ddlforge Rule: Identity column sequence reset with START/RESTART <= 1
 *
 * Rule ID: identity-sequence-start-with
 * Severity: BLOCKER
 * Lock: ACCESS EXCLUSIVE
 *
 * Fires when ALTER TABLE ... ALTER COLUMN ... ADD IDENTITY (or SET GENERATED)
 * specifies a START WITH or RESTART value <= 1 on a table that likely already
 * has data, creating a duplicate key hazard.
 */

import { Rule, RuleContext, Finding } from './types.js';
import { PostgresLockLevel } from '../engine/locks.js';

/**
 * Parse the sequence options list that follows ADD GENERATED ... AS IDENTITY
 * or SET GENERATED ... syntax.  Returns the start/restart value if one is
 * explicitly declared that is <= 1.
 */
function detectLowStartRestart(tokens: Array<{ value: string; raw: string }>, startIdx: number): {
  keyword: 'START' | 'RESTART';
  value: number;
} | null {
  // Scan forward inside the parenthesised sequence options block (if present)
  // or inline sequence options without parens.
  let i = startIdx;
  let parenDepth = 0;

  while (i < tokens.length) {
    const t = tokens[i];

    if (t.value === '(') {
      parenDepth++;
      i++;
      continue;
    }
    if (t.value === ')') {
      if (parenDepth === 0) break; // end of outer clause
      parenDepth--;
      i++;
      continue;
    }

    // Only scan inside sequence options block (depth >= 0 is fine since options
    // can appear both with and without enclosing parens).
    if (t.value === 'START') {
      // START [WITH] <n>
      let next = i + 1;
      if (tokens[next]?.value === 'WITH') next++;
      const numRaw = tokens[next]?.raw;
      if (numRaw !== undefined) {
        const n = parseFloat(numRaw);
        if (!isNaN(n) && n <= 1) {
          return { keyword: 'START', value: n };
        }
      }
    }

    if (t.value === 'RESTART') {
      // RESTART [WITH] <n>
      let next = i + 1;
      if (tokens[next]?.value === 'WITH') next++;
      const numRaw = tokens[next]?.raw;
      if (numRaw !== undefined) {
        const n = parseFloat(numRaw);
        if (!isNaN(n) && n <= 1) {
          return { keyword: 'RESTART', value: n };
        }
      }
    }

    // Stop scanning at top-level comma (next alter sub-command) or semicolon
    if (parenDepth === 0 && (t.value === ',' || t.value === ';')) break;

    i++;
  }

  return null;
}

export const identitySequenceStartWithRule: Rule = {
  id: 'identity-sequence-start-with',
  name: 'Identity column sequence reset with START/RESTART <= 1',
  description:
    'Setting START WITH or RESTART WITH to a value <= 1 on an identity column risks duplicate key errors ' +
    'because the sequence counter will restart from 1 on a table that already contains rows with ids >= 1.',
  defaultSeverity: 'BLOCKER',
  lockLevel: PostgresLockLevel.ACCESS_EXCLUSIVE,

  check(context: RuleContext): Finding[] {
    const findings: Finding[] = [];

    for (const stmt of context.statements) {
      if (stmt.hasIgnore(this.id)) continue;

      const tokens = stmt.tokens;
      if (tokens.length < 5) continue;

      // Must be ALTER TABLE
      if (tokens[0].value !== 'ALTER' || tokens[1].value !== 'TABLE') continue;

      // Skip optional modifiers before table name
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

      // Collect table name (including schema-qualified: schema.table)
      const tableParts: string[] = [];
      if (idx < tokens.length) {
        tableParts.push(tokens[idx].raw);
        idx++;
        while (idx < tokens.length && tokens[idx]?.value === '.') {
          tableParts.push('.');
          idx++;
          if (idx < tokens.length) {
            tableParts.push(tokens[idx].raw);
            idx++;
          }
        }
      }
      const tableName = tableParts.join('') || 'table';

      // Scan for sub-commands
      let parenDepth = 0;
      while (idx < tokens.length) {
        if (tokens[idx].value === '(') { parenDepth++; idx++; continue; }
        if (tokens[idx].value === ')') { parenDepth--; idx++; continue; }

        if (parenDepth === 0 && tokens[idx].value === 'ALTER') {
          // ALTER [COLUMN] <col_name>
          let cur = idx + 1;
          if (tokens[cur]?.value === 'COLUMN') cur++;
          // Skip IF EXISTS on column
          if (tokens[cur]?.value === 'IF' && tokens[cur + 1]?.value === 'EXISTS') cur += 2;

          const colName = tokens[cur]?.raw;
          if (!colName) { idx++; continue; }
          cur++;

          // Look for ADD GENERATED or SET GENERATED patterns:
          //   ALTER COLUMN col ADD GENERATED { ALWAYS | BY DEFAULT } AS IDENTITY [( sequence_options )]
          //   ALTER COLUMN col SET GENERATED
          //   ALTER COLUMN col RESTART [WITH n]          -- direct restart
          //   ALTER COLUMN col { SET | DROP } IDENTITY   -- identity management
          let isIdentityClause = false;

          if (tokens[cur]?.value === 'ADD' && tokens[cur + 1]?.value === 'GENERATED') {
            isIdentityClause = true;
            cur += 2;
            // Skip ALWAYS / BY DEFAULT / AS IDENTITY
            while (cur < tokens.length && !['(', ',', ';'].includes(tokens[cur].value)) {
              cur++;
            }
          } else if (tokens[cur]?.value === 'SET' && tokens[cur + 1]?.value === 'GENERATED') {
            isIdentityClause = true;
            cur += 2;
            while (cur < tokens.length && !['(', ',', ';'].includes(tokens[cur].value)) {
              cur++;
            }
          } else if (tokens[cur]?.value === 'RESTART') {
            // Direct RESTART [WITH n] on identity column
            isIdentityClause = true;
          }

          if (isIdentityClause) {
            const bad = detectLowStartRestart(tokens, cur);
            if (bad) {
              findings.push({
                ruleId: this.id,
                ruleName: this.name,
                severity: this.defaultSeverity,
                lockLevel: this.lockLevel,
                message:
                  `Column "${colName}" on table "${tableName}" has identity sequence ${bad.keyword} WITH ${bad.value}, ` +
                  `which will reset the counter to ${bad.value} and cause duplicate key errors on populated tables.`,
                detail:
                  `Resetting an identity sequence counter to a value <= 1 means the next generated id ` +
                  `will be 1 (or the specified low value), which collides with existing rows. ` +
                  `This results in a duplicate key violation (SQLSTATE 23505) at INSERT time.`,
                suggestion:
                  `Omit START WITH / RESTART WITH from the ADD GENERATED ... AS IDENTITY clause:\n` +
                  `   ALTER TABLE ${tableName} ALTER COLUMN ${colName} ADD GENERATED ALWAYS AS IDENTITY;\n` +
                  `Then set the sequence to a safe value:\n` +
                  `   SELECT setval(pg_get_serial_sequence('${tableName}', '${colName}'), (SELECT MAX(${colName}) FROM ${tableName}));`,
                file: context.filePath,
                line: stmt.startLine,
                column: stmt.startColumn,
                codeSnippet: stmt.raw,
              });
            }
          }
        }

        idx++;
      }
    }

    return findings;
  },
};

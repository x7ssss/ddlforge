/**
 * ddlforge Rule: ADD CONSTRAINT FOREIGN KEY without covering index
 *
 * Severity: WARNING
 * Lock: NONE (DDL lock concern is indirect — sequential scans on parent writes)
 *
 * Fires whenever ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY is detected,
 * regardless of NOT VALID, because we cannot inspect existing indexes from SQL
 * alone.  This is a structural warning reminding authors to pre-create an index.
 */

import { Rule, RuleContext, Finding } from './types.js';
import { PostgresLockLevel } from '../engine/locks.js';
import { Token } from '../lexer/tokens.js';

interface ForeignKeyInfo {
  constraintName?: string;
  fkCols: string;
  parentTable: string;
}

/**
 * Scan the post-table-name tokens for every ADD ... FOREIGN KEY clause and
 * return information about referencing columns and the parent table.
 */
function extractForeignKeyInfos(tokens: Token[]): ForeignKeyInfo[] {
  const infos: ForeignKeyInfo[] = [];
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

    if (parenDepth === 0 && tokens[i].value === 'ADD') {
      let cur = i + 1;
      let constraintName: string | undefined;

      if (tokens[cur]?.value === 'CONSTRAINT') {
        cur++;
        constraintName = tokens[cur]?.raw;
        cur++;
      }

      if (tokens[cur]?.value === 'FOREIGN' && tokens[cur + 1]?.value === 'KEY') {
        cur += 2; // past FOREIGN KEY

        // Collect the referencing column list: FOREIGN KEY (col1, col2, ...)
        const fkColTokens: string[] = [];
        if (tokens[cur]?.value === '(') {
          cur++; // skip opening paren
          while (cur < tokens.length && tokens[cur].value !== ')') {
            if (tokens[cur].value !== ',') {
              fkColTokens.push(tokens[cur].raw);
            }
            cur++;
          }
          cur++; // skip closing paren
        }

        // Advance to REFERENCES to get the parent table
        let parentTable = '<parent>';
        while (cur < tokens.length) {
          if (tokens[cur].value === 'REFERENCES') {
            cur++;
            parentTable = tokens[cur]?.raw ?? '<parent>';
            break;
          }
          // Stop at a top-level comma (next ADD clause)
          if (tokens[cur].value === ',' && parenDepth === 0) break;
          cur++;
        }

        infos.push({
          constraintName,
          fkCols: fkColTokens.join(', '),
          parentTable,
        });

        i = cur;
        continue;
      }
    }

    i++;
  }

  return infos;
}

export const unindexedForeignKeyRule: Rule = {
  id: 'unindexed-foreign-key',
  name: 'ADD CONSTRAINT FOREIGN KEY without covering index',
  description:
    'Adding a foreign key without a covering index on the referencing columns causes PostgreSQL to perform a sequential scan on the child table whenever a parent row is deleted or updated.',
  defaultSeverity: 'WARNING',
  lockLevel: PostgresLockLevel.NONE,

  check(context: RuleContext): Finding[] {
    const findings: Finding[] = [];

    for (const stmt of context.statements) {
      if (stmt.hasIgnore(this.id)) continue;

      const tokens = stmt.tokens;
      if (tokens.length < 6) continue;

      if (tokens[0].value !== 'ALTER' || tokens[1].value !== 'TABLE') continue;

      // Extract table name
      let idx = 2;
      if (tokens[idx]?.value === 'ONLY') idx++;
      if (tokens[idx]?.value === 'IF' && tokens[idx + 1]?.value === 'EXISTS') idx += 2;
      const tableName = tokens[idx]?.raw ?? 'table';
      idx++;

      const fkInfos = extractForeignKeyInfos(tokens.slice(idx));

      for (const fk of fkInfos) {
        const constraintDisplay = fk.constraintName ? ` (constraint "${fk.constraintName}")` : '';
        const colsDisplay = fk.fkCols || '<fk_cols>';
        const constraintName = fk.constraintName ?? 'fk_name';

        findings.push({
          ruleId: this.id,
          ruleName: this.name,
          severity: this.defaultSeverity,
          lockLevel: this.lockLevel,
          message: `Foreign key${constraintDisplay} on table "${tableName}" references columns that may lack a covering index.`,
          detail:
            `When a parent row is deleted or updated, PostgreSQL performs a sequential scan on the child table ` +
            `for any unindexed foreign key referencing columns. Under high write load on the parent table, ` +
            `this causes lock contention and slow queries.`,
          suggestion:
            `Create an index covering the foreign key referencing columns before adding the constraint:\n` +
            `   CREATE INDEX CONCURRENTLY idx_${tableName}_fk ON ${tableName} (${colsDisplay});\n` +
            `Then add the constraint:\n` +
            `   ALTER TABLE ${tableName} ADD CONSTRAINT ${constraintName} FOREIGN KEY (${colsDisplay}) REFERENCES ${fk.parentTable}(...) NOT VALID;\n` +
            `   ALTER TABLE ${tableName} VALIDATE CONSTRAINT ${constraintName};`,
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

/**
 * ddlforge Rule: Prisma Silent Field Rename (Destructive Data Loss)
 *
 * Detects paired DROP COLUMN + ADD COLUMN on the same table, which Prisma
 * generates for renamed fields, causing irreversible production data wipe.
 *
 * Severity: BLOCKER
 */

import { Rule, RuleContext, Finding } from './types.js';
import { PostgresLockLevel } from '../engine/locks.js';
import { Token } from '../lexer/tokens.js';

interface DropColumnAction {
  tableName: string;
  columnName: string;
  line: number;
  column: number;
  raw: string;
}

interface AddColumnAction {
  tableName: string;
  columnName: string;
  line: number;
  column: number;
  raw: string;
}

function parseAlterSubcommands(tokens: Token[]): Array<{ type: 'DROP_COLUMN' | 'ADD_COLUMN'; columnName: string }> {
  const results: Array<{ type: 'DROP_COLUMN' | 'ADD_COLUMN'; columnName: string }> = [];
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

    if (parenDepth === 0) {
      // Match DROP [COLUMN] [IF EXISTS] <col>
      if (tokens[i].value === 'DROP') {
        let nextIdx = i + 1;
        if (tokens[nextIdx]?.value === 'COLUMN') nextIdx++;
        if (tokens[nextIdx]?.value === 'IF' && tokens[nextIdx + 1]?.value === 'EXISTS') nextIdx += 2;

        // Make sure it's not DROP CONSTRAINT or DROP INDEX
        if (tokens[i + 1]?.value !== 'CONSTRAINT' && tokens[i + 1]?.value !== 'INDEX') {
          const colName = tokens[nextIdx]?.raw;
          if (colName) {
            results.push({ type: 'DROP_COLUMN', columnName: colName });
          }
        }
      }

      // Match ADD [COLUMN] [IF NOT EXISTS] <col>
      if (tokens[i].value === 'ADD') {
        let nextIdx = i + 1;
        if (tokens[nextIdx]?.value === 'COLUMN') nextIdx++;
        if (tokens[nextIdx]?.value === 'IF' && tokens[nextIdx + 1]?.value === 'NOT' && tokens[nextIdx + 2]?.value === 'EXISTS') nextIdx += 3;

        if (tokens[i + 1]?.value !== 'CONSTRAINT' && tokens[nextIdx]?.value !== 'CONSTRAINT') {
          const colName = tokens[nextIdx]?.raw;
          if (colName) {
            results.push({ type: 'ADD_COLUMN', columnName: colName });
          }
        }
      }
    }

    i++;
  }

  return results;
}

export const prismaRenameDropAddRule: Rule = {
  id: 'prisma-silent-rename-data-loss',
  name: 'Prisma Silent Field Rename (Destructive Data Loss)',
  description: 'Detects paired DROP COLUMN and ADD COLUMN on the same table, preventing irreversible data destruction caused by Prisma field renames.',
  defaultSeverity: 'BLOCKER',
  lockLevel: PostgresLockLevel.ACCESS_EXCLUSIVE,

  check(context: RuleContext): Finding[] {
    const findings: Finding[] = [];
    const dropColumnsByTable = new Map<string, DropColumnAction[]>();
    const addColumnsByTable = new Map<string, AddColumnAction[]>();

    for (const stmt of context.statements) {
      if (stmt.hasIgnore(this.id)) continue;

      const tokens = stmt.tokens;
      if (tokens.length < 5) continue;

      if (tokens[0].value !== 'ALTER' || tokens[1].value !== 'TABLE') continue;

      let idx = 2;
      if (tokens[idx]?.value === 'ONLY') idx++;
      if (tokens[idx]?.value === 'IF' && tokens[idx + 1]?.value === 'EXISTS') idx += 2;
      const tableName = tokens[idx]?.raw ?? '';
      if (!tableName) continue;
      const normalizedTable = tableName.replace(/^"|"$/g, '').toLowerCase();
      idx++;

      const subTokens = tokens.slice(idx);
      const actions = parseAlterSubcommands(subTokens);

      for (const action of actions) {
        if (action.type === 'DROP_COLUMN') {
          const list = dropColumnsByTable.get(normalizedTable) ?? [];
          list.push({
            tableName,
            columnName: action.columnName,
            line: stmt.startLine,
            column: stmt.startColumn,
            raw: stmt.raw,
          });
          dropColumnsByTable.set(normalizedTable, list);
        } else if (action.type === 'ADD_COLUMN') {
          const list = addColumnsByTable.get(normalizedTable) ?? [];
          list.push({
            tableName,
            columnName: action.columnName,
            line: stmt.startLine,
            column: stmt.startColumn,
            raw: stmt.raw,
          });
          addColumnsByTable.set(normalizedTable, list);
        }
      }
    }

    // Correlate DROP and ADD on the same table
    for (const [tableKey, dropList] of dropColumnsByTable.entries()) {
      const addList = addColumnsByTable.get(tableKey);
      if (!addList || addList.length === 0) continue;

      for (const drop of dropList) {
        for (const add of addList) {
          findings.push({
            ruleId: this.id,
            ruleName: this.name,
            severity: this.defaultSeverity,
            lockLevel: this.lockLevel,
            message: `Destructive column replacement on "${drop.tableName}": dropped "${drop.columnName}" and added "${add.columnName}".`,
            detail:
              `Detected DROP COLUMN "${drop.columnName}" paired with ADD COLUMN "${add.columnName}" on table "${drop.tableName}". ` +
              'Prisma Migrate generates this pattern when a model field is renamed, which results in permanent, irreversible data destruction in production!',
            suggestion:
              `If this is a rename, replace the DROP/ADD pair with a non-destructive rename:\n` +
              `   ALTER TABLE ${drop.tableName} RENAME COLUMN ${drop.columnName} TO ${add.columnName};\n` +
              `Or use Prisma's @map attribute to map the Prisma field name without modifying the database column name.`,
            file: context.filePath,
            line: drop.line,
            column: drop.column,
            codeSnippet: `${drop.raw}\n-- paired with --\n${add.raw}`,
          });
        }
      }
    }

    return findings;
  },
};

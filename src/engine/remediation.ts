/**
 * ddlforge - Automated Zero-Downtime Remediation Generator Engine
 *
 * Generates deterministic, backward-compatible multi-phase SQL remediation
 * templates for high-risk PostgreSQL DDL operations without any external dependencies:
 *
 * 1. Non-concurrent index (CREATE INDEX without CONCURRENTLY):
 *    -> Phase 1: CREATE INDEX CONCURRENTLY <name> ON <table> (<cols>); (with reminder to run outside transaction blocks)
 *
 * 2. Unvalidated Foreign Key (ALTER TABLE <table> ADD CONSTRAINT <name> FOREIGN KEY ...):
 *    -> Phase 1: ALTER TABLE <table> ADD CONSTRAINT <name> FOREIGN KEY (...) REFERENCES ... NOT VALID;
 *    -> Phase 2: ALTER TABLE <table> VALIDATE CONSTRAINT <name>;
 *
 * 3. Unsafe NOT NULL on existing populated column (ALTER TABLE <table> ALTER COLUMN <col> SET NOT NULL):
 *    -> Phase 1: ALTER TABLE <table> ADD CONSTRAINT chk_<col>_not_null CHECK (<col> IS NOT NULL) NOT VALID;
 *    -> Phase 2: ALTER TABLE <table> VALIDATE CONSTRAINT chk_<col>_not_null;
 *    -> Phase 3: ALTER TABLE <table> ALTER COLUMN <col> SET NOT NULL;
 *    -> Phase 4: ALTER TABLE <table> DROP CONSTRAINT chk_<col>_not_null;
 *
 * 4. Adding column with non-constant DEFAULT / NOT NULL:
 *    -> Phase 1: Add column nullable without default.
 *    -> Phase 2: Backfill data in asynchronous batches.
 *    -> Phase 3: Set default for future rows & attach constraint via NOT VALID -> VALIDATE.
 */

import { Finding } from '../rules/types.js';
import { Statement } from '../lexer/tokens.js';

export function cleanIdentifier(id: string): string {
  return id.replace(/["`]/g, '').trim();
}

/**
 * 1. Non-concurrent index remediation generator
 */
export interface IndexConcurrentlyParams {
  indexName?: string;
  table: string;
  columns: string;
  isUnique?: boolean;
  extra?: string;
}

export function generateIndexConcurrentlyRemediation(
  paramsOrSql: IndexConcurrentlyParams | string
): string {
  let table = 'table_name';
  let indexName = 'idx_name';
  let columns = 'column_name';
  let isUnique = false;
  let extra = '';

  if (typeof paramsOrSql === 'string') {
    const raw = paramsOrSql.trim().replace(/;+$/, '');
    const uniqueMatch = /^CREATE\s+(UNIQUE\s+)?INDEX/i.exec(raw);
    isUnique = Boolean(uniqueMatch?.[1]);

    // Match CREATE [UNIQUE] INDEX [CONCURRENTLY] [IF NOT EXISTS] <name> ON [ONLY] <table> [USING <method>] (<cols>) [extra]
    const m = /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([^\s(]+)?\s*ON\s+(?:ONLY\s+)?([^\s(]+)(?:\s+USING\s+[^\s(]+)?\s*(\([^;]+\))(.*)$/i.exec(raw);
    if (m) {
      indexName = m[1] ? cleanIdentifier(m[1]) : '';
      table = cleanIdentifier(m[2]);
      columns = m[3].trim();
      extra = m[4]?.trim() ? ' ' + m[4].trim() : '';

      // Strip outer parens from columns for clean representation if needed, but keeping (cols) is safe
      if (columns.startsWith('(') && columns.endsWith(')')) {
        columns = columns.slice(1, -1).trim();
      }
      if (!indexName) {
        const cleanCol = columns.replace(/[^a-zA-Z0-9_]/g, '_');
        indexName = `idx_${table}_${cleanCol}`;
      }
    } else {
      // Fallback: check if CONCURRENTLY can be cleanly injected
      const modified = raw.replace(/^CREATE\s+(UNIQUE\s+)?INDEX\s+/i, (match, u) => {
        return `CREATE ${u ? 'UNIQUE ' : ''}INDEX CONCURRENTLY `;
      });
      return [
        '-- Phase 1: Create index concurrently (run outside transaction blocks)',
        '-- Reminder: Run outside transaction blocks',
        `${modified};`,
      ].join('\n');
    }
  } else {
    table = cleanIdentifier(paramsOrSql.table);
    columns = paramsOrSql.columns.trim();
    if (columns.startsWith('(') && columns.endsWith(')')) {
      columns = columns.slice(1, -1).trim();
    }
    indexName = paramsOrSql.indexName
      ? cleanIdentifier(paramsOrSql.indexName)
      : `idx_${table}_${columns.replace(/[^a-zA-Z0-9_]/g, '_')}`;
    isUnique = Boolean(paramsOrSql.isUnique);
    extra = paramsOrSql.extra ? ' ' + paramsOrSql.extra.trim() : '';
  }

  const prefix = isUnique ? 'CREATE UNIQUE INDEX CONCURRENTLY' : 'CREATE INDEX CONCURRENTLY';
  return [
    '-- Phase 1: Create index concurrently (run outside transaction blocks)',
    '-- Reminder: Run outside transaction blocks',
    `${prefix} ${indexName} ON ${table} (${columns})${extra};`,
  ].join('\n');
}

/**
 * 2. Unvalidated foreign key remediation generator
 */
export interface ForeignKeyRemediationParams {
  table: string;
  constraintName?: string;
  column: string;
  foreignTable: string;
  foreignColumn: string;
  extra?: string;
}

export function generateForeignKeyRemediation(
  paramsOrSql: ForeignKeyRemediationParams | string
): string {
  let table = 'table_name';
  let constraintName = 'fk_name';
  let column = 'column_name';
  let foreignTable = 'foreign_table';
  let foreignColumn = 'id';
  let extra = '';

  if (typeof paramsOrSql === 'string') {
    const raw = paramsOrSql.trim().replace(/;+$/, '');
    // Match ALTER TABLE [ONLY] <table> ADD [CONSTRAINT <name>] FOREIGN KEY (<cols>) REFERENCES <fTable> (<fCols>) [extra]
    const m = /ALTER\s+TABLE\s+(?:ONLY\s+|IF\s+EXISTS\s+)*([^\s;]+)\s+ADD\s+(?:CONSTRAINT\s+([^\s;]+)\s+)?FOREIGN\s+KEY\s*\(([^)]+)\)\s*REFERENCES\s+([^\s(]+)\s*(?:\(([^)]+)\))?(.*)/i.exec(raw);
    if (m) {
      table = cleanIdentifier(m[1]);
      constraintName = m[2] ? cleanIdentifier(m[2]) : '';
      column = m[3].trim();
      foreignTable = cleanIdentifier(m[4]);
      foreignColumn = m[5] ? m[5].trim() : 'id';
      extra = m[6]?.trim() ? ' ' + m[6].trim().replace(/\s*NOT\s+VALID/i, '') : '';

      if (!constraintName) {
        const cleanCol = column.replace(/[^a-zA-Z0-9_]/g, '_');
        constraintName = `fk_${table}_${cleanCol}`;
      }
    }
  } else {
    table = cleanIdentifier(paramsOrSql.table);
    column = paramsOrSql.column.trim();
    foreignTable = cleanIdentifier(paramsOrSql.foreignTable);
    foreignColumn = paramsOrSql.foreignColumn.trim();
    extra = paramsOrSql.extra ? ' ' + paramsOrSql.extra.trim() : '';
    constraintName = paramsOrSql.constraintName
      ? cleanIdentifier(paramsOrSql.constraintName)
      : `fk_${table}_${column.replace(/[^a-zA-Z0-9_]/g, '_')}`;
  }

  return [
    '-- Phase 1: Add foreign key constraint as NOT VALID',
    `ALTER TABLE ${table} ADD CONSTRAINT ${constraintName} FOREIGN KEY (${column}) REFERENCES ${foreignTable} (${foreignColumn})${extra} NOT VALID;`,
    '',
    '-- Phase 2: Validate foreign key constraint in isolation',
    `ALTER TABLE ${table} VALIDATE CONSTRAINT ${constraintName};`,
  ].join('\n');
}

/**
 * 3. Unsafe NOT NULL on existing column remediation generator
 */
export interface SetNotNullParams {
  table: string;
  column: string;
}

export function generateSetNotNullRemediation(
  paramsOrSql: SetNotNullParams | string
): string {
  let table = 'table_name';
  let column = 'column_name';

  if (typeof paramsOrSql === 'string') {
    const raw = paramsOrSql.trim().replace(/;+$/, '');
    // Match ALTER TABLE [ONLY] <table> ALTER [COLUMN] <col> SET NOT NULL
    const m = /ALTER\s+TABLE\s+(?:ONLY\s+|IF\s+EXISTS\s+)*([^\s;]+)\s+ALTER\s+(?:COLUMN\s+)?([^\s;]+)\s+SET\s+NOT\s+NULL/i.exec(raw);
    if (m) {
      table = cleanIdentifier(m[1]);
      column = cleanIdentifier(m[2]);
    }
  } else {
    table = cleanIdentifier(paramsOrSql.table);
    column = cleanIdentifier(paramsOrSql.column);
  }

  const chkName = `chk_${column}_not_null`;

  return [
    '-- Phase 1: Add check constraint as NOT VALID',
    `ALTER TABLE ${table} ADD CONSTRAINT ${chkName} CHECK (${column} IS NOT NULL) NOT VALID;`,
    '',
    '-- Phase 2: Validate check constraint across existing rows',
    `ALTER TABLE ${table} VALIDATE CONSTRAINT ${chkName};`,
    '',
    '-- Phase 3: Set column NOT NULL (instant validation in PostgreSQL 12+)',
    `ALTER TABLE ${table} ALTER COLUMN ${column} SET NOT NULL;`,
    '',
    '-- Phase 4: Drop redundant check constraint',
    `ALTER TABLE ${table} DROP CONSTRAINT ${chkName};`,
  ].join('\n');
}

/**
 * 4. Adding column with non-constant DEFAULT / NOT NULL remediation generator
 */
export interface AddColumnNotNullParams {
  table: string;
  column: string;
  type?: string;
  defaultValue?: string;
}

export function generateAddColumnNotNullRemediation(
  paramsOrSql: AddColumnNotNullParams | string
): string {
  let table = 'table_name';
  let column = 'column_name';
  let colType = 'TEXT';
  let defaultValue: string | undefined = undefined;

  if (typeof paramsOrSql === 'string') {
    const raw = paramsOrSql.trim().replace(/;+$/, '');
    // Match ALTER TABLE [ONLY] <table> ADD [COLUMN] <col> <type> [DEFAULT <def>] NOT NULL
    // or ALTER TABLE [ONLY] <table> ADD [COLUMN] <col> <type> NOT NULL [DEFAULT <def>]
    const m = /ALTER\s+TABLE\s+(?:ONLY\s+|IF\s+EXISTS\s+)*([^\s;]+)\s+ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([^\s;]+)\s+([^\s;,]+(?:\([^)]+\))?)(.*)/i.exec(raw);
    if (m) {
      table = cleanIdentifier(m[1]);
      column = cleanIdentifier(m[2]);
      colType = m[3].trim();
      const rest = m[4] || '';

      const defMatch = /DEFAULT\s+([^,;]+?)(?:\s+NOT\s+NULL|\s*$)/i.exec(rest);
      if (defMatch) {
        defaultValue = defMatch[1].trim();
      } else {
        const defMatch2 = /NOT\s+NULL\s+DEFAULT\s+([^,;]+)/i.exec(rest);
        if (defMatch2) {
          defaultValue = defMatch2[1].trim();
        }
      }
    }
  } else {
    table = cleanIdentifier(paramsOrSql.table);
    column = cleanIdentifier(paramsOrSql.column);
    colType = paramsOrSql.type ? paramsOrSql.type.trim() : 'TEXT';
    defaultValue = paramsOrSql.defaultValue;
  }

  const backfillVal = defaultValue !== undefined ? defaultValue : `'default_value'`;
  const chkName = `chk_${column}_not_null`;

  const lines = [
    '-- Phase 1: Add column nullable without default',
    `ALTER TABLE ${table} ADD COLUMN ${column} ${colType};`,
    '',
    '-- Phase 2: Backfill data in asynchronous batches',
    'DO $$',
    'DECLARE',
    '  rows_updated INT;',
    'BEGIN',
    '  LOOP',
    `    UPDATE ${table}`,
    `    SET ${column} = ${backfillVal}`,
    '    WHERE ctid IN (',
    `      SELECT ctid FROM ${table}`,
    `      WHERE ${column} IS NULL`,
    '      LIMIT 5000',
    '    );',
    '    GET DIAGNOSTICS rows_updated = ROW_COUNT;',
    '    EXIT WHEN rows_updated = 0;',
    '    PERFORM pg_sleep(0.1);',
    '    COMMIT;',
    '  END LOOP;',
    'END $$;',
    '',
    '-- Phase 3: Set default for future rows & attach constraint via NOT VALID -> VALIDATE',
  ];

  if (defaultValue !== undefined) {
    lines.push(`ALTER TABLE ${table} ALTER COLUMN ${column} SET DEFAULT ${defaultValue};`);
  }
  lines.push(`ALTER TABLE ${table} ADD CONSTRAINT ${chkName} CHECK (${column} IS NOT NULL) NOT VALID;`);
  lines.push(`ALTER TABLE ${table} VALIDATE CONSTRAINT ${chkName};`);
  lines.push(`ALTER TABLE ${table} ALTER COLUMN ${column} SET NOT NULL;`);
  lines.push(`ALTER TABLE ${table} DROP CONSTRAINT ${chkName};`);

  return lines.join('\n');
}

/**
 * Generates an automated zero-downtime remediation template for a finding.
 */
export function generateRemediation(
  finding: Finding,
  statementOrSql?: Statement | string
): string | undefined {
  if (finding.remediation && finding.remediation.trim().length > 0) {
    return finding.remediation;
  }

  const rawSql = typeof statementOrSql === 'string'
    ? statementOrSql
    : statementOrSql?.raw ?? finding.codeSnippet ?? '';

  const ruleId = finding.ruleId.toLowerCase();

  // 1. Non-concurrent index
  if (ruleId === 'require-concurrent-index' || ruleId === 'non-concurrent-index') {
    return generateIndexConcurrentlyRemediation(rawSql);
  }

  // 2. Unvalidated foreign key
  if (
    ruleId === 'foreign-key-missing-not-valid' ||
    ruleId === 'unvalidated-foreign-key' ||
    ruleId === 'foreign-key-not-valid'
  ) {
    return generateForeignKeyRemediation(rawSql);
  }

  // 3. Unsafe NOT NULL on existing populated column
  if (ruleId === 'set-not-null-full-scan') {
    return generateSetNotNullRemediation(rawSql);
  }

  // 4. Add column NOT NULL / default
  if (
    ruleId === 'add-column-not-null-without-default' ||
    ruleId === 'add-column-not-null'
  ) {
    return generateAddColumnNotNullRemediation(rawSql);
  }

  // 5. Primary key missing using index
  if (
    ruleId === 'add-primary-key-missing-using-index' ||
    ruleId === 'primary-key-missing-using-index'
  ) {
    const raw = rawSql.trim().replace(/;+$/, '');
    const m = /ALTER\s+TABLE\s+(?:ONLY\s+|IF\s+EXISTS\s+)*([^\s;]+)\s+ADD\s+(?:CONSTRAINT\s+([^\s;]+)\s+)?PRIMARY\s+KEY\s*\(([^)]+)\)/i.exec(raw);
    if (m) {
      const table = cleanIdentifier(m[1]);
      const constraint = m[2] ? cleanIdentifier(m[2]) : `pk_${table}`;
      const cols = m[3].trim();
      const idxName = `idx_${table}_${cols.replace(/[^a-zA-Z0-9_]/g, '_')}_pk`;
      return [
        '-- Phase 1: Create unique index concurrently (run outside transaction blocks)',
        `CREATE UNIQUE INDEX CONCURRENTLY ${idxName} ON ${table} (${cols});`,
        '',
        '-- Phase 2: Attach index as primary key constraint',
        `ALTER TABLE ${table} ADD CONSTRAINT ${constraint} PRIMARY KEY USING INDEX ${idxName};`,
      ].join('\n');
    }
  }

  // 6. Check constraint missing NOT VALID
  if (
    ruleId === 'check-constraint-missing-not-valid' ||
    ruleId === 'check-constraint-not-valid'
  ) {
    const raw = rawSql.trim().replace(/;+$/, '');
    const m = /ALTER\s+TABLE\s+(?:ONLY\s+|IF\s+EXISTS\s+)*([^\s;]+)\s+ADD\s+(?:CONSTRAINT\s+([^\s;]+)\s+)?CHECK\s*(\([^;]+\))/i.exec(raw);
    if (m) {
      const table = cleanIdentifier(m[1]);
      const constraint = m[2] ? cleanIdentifier(m[2]) : `chk_${table}_${Date.now()}`;
      const expr = m[3].trim();
      return [
        '-- Phase 1: Add check constraint as NOT VALID',
        `ALTER TABLE ${table} ADD CONSTRAINT ${constraint} CHECK ${expr} NOT VALID;`,
        '',
        '-- Phase 2: Validate check constraint across existing rows',
        `ALTER TABLE ${table} VALIDATE CONSTRAINT ${constraint};`,
      ].join('\n');
    }
  }

  // 7. Reindex missing concurrently
  if (ruleId === 'reindex-missing-concurrently') {
    const raw = rawSql.trim().replace(/;+$/, '');
    const m = /^REINDEX\s+(TABLE|INDEX|SCHEMA)\s+([^\s;]+)/i.exec(raw);
    if (m) {
      return [
        '-- Phase 1: Reindex concurrently (run outside transaction blocks)',
        `REINDEX ${m[1].toUpperCase()} CONCURRENTLY ${m[2]};`,
      ].join('\n');
    }
  }

  // 8. Volatile default
  if (ruleId === 'volatile-default') {
    return generateAddColumnNotNullRemediation(rawSql);
  }

  // 9. Non-concurrent drop index
  if (ruleId === 'non-concurrent-drop-index') {
    const raw = rawSql.trim().replace(/;+$/, '');
    const m = /^DROP\s+INDEX\s+(?:IF\s+EXISTS\s+)?([^\s;]+)/i.exec(raw);
    const idxName = m ? m[1] : 'index_name';
    return [
      '-- Phase 1: Drop index concurrently (run outside transaction blocks)',
      `DROP INDEX CONCURRENTLY ${idxName};`,
    ].join('\n');
  }

  // 10. Partition attach scan lock
  if (ruleId === 'partition-scan-lock' || ruleId === 'attach-partition-missing-check') {
    const raw = rawSql.trim().replace(/;+$/, '');
    const m = /ALTER\s+TABLE\s+(?:ONLY\s+|IF\s+EXISTS\s+)*([^\s;]+)\s+ATTACH\s+PARTITION\s+([^\s;]+)(.*)/i.exec(raw);
    if (m) {
      const parent = cleanIdentifier(m[1]);
      const part = cleanIdentifier(m[2]);
      const rest = m[3] ? m[3].trim() : '';
      return [
        `-- Phase 1: Add NOT VALID check constraint matching partition bounds on "${part}"`,
        `ALTER TABLE ${part} ADD CONSTRAINT chk_${part}_bounds CHECK (<bounds_condition>) NOT VALID;`,
        '',
        `-- Phase 2: Validate constraint asynchronously without blocking writes`,
        `ALTER TABLE ${part} VALIDATE CONSTRAINT chk_${part}_bounds;`,
        '',
        `-- Phase 3: Attach partition (full table scan skipped because constraint is validated)`,
        `ALTER TABLE ${parent} ATTACH PARTITION ${part} ${rest};`,
        '',
        `-- Phase 4: Drop redundant check constraint`,
        `ALTER TABLE ${part} DROP CONSTRAINT chk_${part}_bounds;`,
      ].join('\n');
    }
  }

  return undefined;
}

/**
 * Attaches zero-downtime remediation templates to findings missing them.
 */
export function attachRemediations(
  findings: Finding[],
  statements?: Statement[]
): Finding[] {
  for (const finding of findings) {
    if (!finding.remediation || finding.remediation.trim().length === 0) {
      // Find matching statement if available
      let matchingStmt: Statement | undefined;
      if (statements && statements.length > 0) {
        matchingStmt = statements.find(
          s => s.startLine === finding.line || (s.startLine <= finding.line && s.endLine >= finding.line)
        );
      }
      const rem = generateRemediation(finding, matchingStmt);
      if (rem) {
        finding.remediation = rem;
      }
    }
  }
  return findings;
}

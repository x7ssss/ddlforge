/**
 * ddlforge - Virtual Schema & View-Based Expand Engine
 *
 * Generates versioned virtual schemas (e.g. public_v1, public_v2) containing
 * alias views with explicit INSTEAD OF triggers over physical tables.
 *
 * Reconstructs NEW record projections from base RETURNING clauses to support
 * ORMs (Prisma, Drizzle) on upserts and RETURNING * hydration.
 */

import * as fs from 'node:fs';
import { splitStatements } from '../lexer/sqlTokenizer.js';
import { Statement } from '../lexer/tokens.js';

export interface VirtualColumnMapping {
  viewColumn: string;
  physicalColumn: string;
}

export interface VirtualTableDef {
  tableName: string;
  viewName?: string;
  physicalSchema?: string;
  primaryKey?: string;
  columns: Array<string | VirtualColumnMapping>;
}

export interface VirtualSchemaOptions {
  version: string; // e.g. 'v1', 'v2', 'public_v2'
  baseSchema?: string; // default 'public'
  migrationSql?: string;
  filePath?: string;
  tables?: VirtualTableDef[];
}

export interface GeneratedView {
  tableName: string;
  viewName: string;
  viewSql: string;
  insertTriggerSql: string;
  updateTriggerSql: string;
  deleteTriggerSql: string;
  fullSql: string;
}

export interface VirtualSchemaResult {
  version: string;
  schemaName: string;
  routingSql: string;
  views: GeneratedView[];
  fullSql: string;
}

/**
 * Normalizes a version tag into a schema name (e.g. 'v2' -> 'public_v2').
 */
export function normalizeSchemaName(version: string, baseSchema: string = 'public'): string {
  const clean = version.trim();
  if (clean.startsWith(baseSchema + '_')) {
    return clean;
  }
  if (clean.startsWith('v') || clean.startsWith('V')) {
    return `${baseSchema}_${clean.toLowerCase()}`;
  }
  return `${baseSchema}_${clean}`;
}

/**
 * Parses DDL statements in migration SQL to extract table and column definitions.
 */
export function parseTablesFromSql(sql: string): VirtualTableDef[] {
  const statements: Statement[] = splitStatements(sql);
  const tableMap = new Map<string, VirtualTableDef>();

  for (const stmt of statements) {
    const raw = stmt.raw;
    const tokens = stmt.tokens;
    if (tokens.length === 0) continue;

    const t0 = tokens[0].value;
    const t1 = tokens[1]?.value;

    // 1. CREATE TABLE [IF NOT EXISTS] <table> (...)
    if (t0 === 'CREATE' && t1 === 'TABLE') {
      let idx = 2;
      if (tokens[idx]?.value === 'IF' && tokens[idx + 1]?.value === 'NOT' && tokens[idx + 2]?.value === 'EXISTS') {
        idx += 3;
      }
      const rawTableName = tokens[idx]?.raw;
      if (rawTableName) {
        const cleanTable = rawTableName.replace(/["`]/g, '');
        const tableDef = extractTableColumnsFromCreate(raw, cleanTable);
        tableMap.set(cleanTable, tableDef);
      }
      continue;
    }

    // 2. ALTER TABLE <table> ADD COLUMN <col>
    if (t0 === 'ALTER' && t1 === 'TABLE') {
      let idx = 2;
      while (idx < tokens.length) {
        if (tokens[idx]?.value === 'IF' && tokens[idx + 1]?.value === 'EXISTS') { idx += 2; continue; }
        if (tokens[idx]?.value === 'ONLY') { idx++; continue; }
        break;
      }
      const rawTableName = tokens[idx]?.raw;
      if (rawTableName) {
        const cleanTable = rawTableName.replace(/["`]/g, '');
        let existing = tableMap.get(cleanTable);
        if (!existing) {
          existing = {
            tableName: cleanTable,
            primaryKey: 'id',
            columns: ['id'],
          };
          tableMap.set(cleanTable, existing);
        }

        // Check for ADD [COLUMN]
        for (let j = idx + 1; j < tokens.length - 1; j++) {
          if (tokens[j].value === 'ADD') {
            let colIdx = j + 1;
            if (tokens[colIdx]?.value === 'COLUMN') colIdx++;
            if (tokens[colIdx]?.value === 'IF' && tokens[colIdx + 1]?.value === 'NOT' && tokens[colIdx + 2]?.value === 'EXISTS') colIdx += 3;
            const colName = tokens[colIdx]?.raw?.replace(/["`]/g, '');
            if (colName && !existing.columns.some(c => (typeof c === 'string' ? c : c.viewColumn) === colName)) {
              existing.columns.push(colName);
            }
          }
        }
      }
    }
  }

  return Array.from(tableMap.values());
}

function extractTableColumnsFromCreate(rawSql: string, tableName: string): VirtualTableDef {
  const columns: string[] = [];
  let primaryKey = 'id';

  const parenStart = rawSql.indexOf('(');
  const parenEnd = rawSql.lastIndexOf(')');
  if (parenStart !== -1 && parenEnd !== -1 && parenEnd > parenStart) {
    const body = rawSql.slice(parenStart + 1, parenEnd);
    // Split on top-level commas
    const parts = splitTopLevelCommas(body);
    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const upper = trimmed.toUpperCase();

      // Check for table-level PRIMARY KEY (col1, col2)
      if (upper.startsWith('PRIMARY KEY') || upper.startsWith('CONSTRAINT')) {
        const pkMatch = trimmed.match(/PRIMARY\s+KEY\s*\(\s*([^)]+)\s*\)/i);
        if (pkMatch) {
          const pkCols = pkMatch[1].split(',').map(s => s.trim().replace(/["`]/g, ''));
          if (pkCols.length > 0 && pkCols[0]) {
            primaryKey = pkCols[0];
          }
        }
        continue;
      }

      // Column definition: <name> <type> ...
      const firstWordMatch = trimmed.match(/^([a-zA-Z0-9_"]+)/);
      if (firstWordMatch) {
        const colName = firstWordMatch[1].replace(/["`]/g, '');
        if (!columns.includes(colName)) {
          columns.push(colName);
        }
        if (upper.includes('PRIMARY KEY')) {
          primaryKey = colName;
        }
      }
    }
  }

  if (columns.length === 0) {
    columns.push('id');
  }

  return {
    tableName,
    primaryKey,
    columns,
  };
}

function splitTopLevelCommas(input: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let depth = 0;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

/**
 * Generates the view definition and INSTEAD OF triggers for a single table.
 */
export function generateTableVirtualView(
  tableDef: VirtualTableDef,
  schemaName: string,
  baseSchema: string = 'public'
): GeneratedView {
  const tableName = tableDef.tableName;
  const viewName = tableDef.viewName || tableName;
  const physicalSchema = tableDef.physicalSchema || baseSchema;
  const pk = tableDef.primaryKey || 'id';

  // Normalize columns and mappings
  const mappings: VirtualColumnMapping[] = tableDef.columns.map(c => {
    if (typeof c === 'string') {
      return { viewColumn: c, physicalColumn: c };
    }
    return c;
  });

  const viewCols = mappings.map(m => `"${m.viewColumn}"`);
  const viewSelectCols = mappings.map(m =>
    m.viewColumn === m.physicalColumn
      ? `"${m.physicalColumn}"`
      : `"${m.physicalColumn}" AS "${m.viewColumn}"`
  );

  // 1. View Definition
  const viewSql = `CREATE OR REPLACE VIEW "${schemaName}"."${viewName}" AS
SELECT
  ${viewSelectCols.join(',\n  ')}
FROM "${physicalSchema}"."${tableName}";`;

  // 2. INSTEAD OF INSERT trigger
  const insertCols = mappings.map(m => `"${m.physicalColumn}"`).join(', ');
  const insertValues = mappings.map(m => `NEW."${m.viewColumn}"`).join(', ');
  const reconstructInsert = mappings.map(m => `  NEW."${m.viewColumn}" := v_row."${m.physicalColumn}";`).join('\n');

  const insertTriggerSql = `CREATE OR REPLACE FUNCTION "${schemaName}"."tf_${viewName}_insert"()
RETURNS TRIGGER AS $$
DECLARE
  v_row "${physicalSchema}"."${tableName}"%ROWTYPE;
BEGIN
  INSERT INTO "${physicalSchema}"."${tableName}" (
    ${insertCols}
  ) VALUES (
    ${insertValues}
  )
  RETURNING * INTO v_row;

  -- Reconstruct projection of NEW record from returning physical row
${reconstructInsert}

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER "trg_${viewName}_insert"
INSTEAD OF INSERT ON "${schemaName}"."${viewName}"
FOR EACH ROW EXECUTE FUNCTION "${schemaName}"."tf_${viewName}_insert"();`;

  // 3. INSTEAD OF UPDATE trigger
  const updateSets = mappings
    .filter(m => m.viewColumn !== pk)
    .map(m => `    "${m.physicalColumn}" = NEW."${m.viewColumn}"`)
    .join(',\n');

  const reconstructUpdate = mappings.map(m => `  NEW."${m.viewColumn}" := v_row."${m.physicalColumn}";`).join('\n');

  const updateTriggerSql = `CREATE OR REPLACE FUNCTION "${schemaName}"."tf_${viewName}_update"()
RETURNS TRIGGER AS $$
DECLARE
  v_row "${physicalSchema}"."${tableName}"%ROWTYPE;
BEGIN
  UPDATE "${physicalSchema}"."${tableName}"
  SET
${updateSets || `    "${pk}" = NEW."${pk}"`}
  WHERE "${pk}" = OLD."${pk}"
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- Reconstruct projection of NEW record from returning physical row
${reconstructUpdate}

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER "trg_${viewName}_update"
INSTEAD OF UPDATE ON "${schemaName}"."${viewName}"
FOR EACH ROW EXECUTE FUNCTION "${schemaName}"."tf_${viewName}_update"();`;

  // 4. INSTEAD OF DELETE trigger
  const deleteTriggerSql = `CREATE OR REPLACE FUNCTION "${schemaName}"."tf_${viewName}_delete"()
RETURNS TRIGGER AS $$
BEGIN
  DELETE FROM "${physicalSchema}"."${tableName}"
  WHERE "${pk}" = OLD."${pk}";
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER "trg_${viewName}_delete"
INSTEAD OF DELETE ON "${schemaName}"."${viewName}"
FOR EACH ROW EXECUTE FUNCTION "${schemaName}"."tf_${viewName}_delete"();`;

  const fullSql = [
    viewSql,
    '',
    insertTriggerSql,
    '',
    updateTriggerSql,
    '',
    deleteTriggerSql,
  ].join('\n');

  return {
    tableName,
    viewName,
    viewSql,
    insertTriggerSql,
    updateTriggerSql,
    deleteTriggerSql,
    fullSql,
  };
}

/**
 * Generates the complete virtual schema with views, instead-of triggers, and routing SQL.
 */
export function generateVirtualSchema(options: VirtualSchemaOptions): VirtualSchemaResult {
  const baseSchema = options.baseSchema || 'public';
  const schemaName = normalizeSchemaName(options.version, baseSchema);

  let tables = options.tables ? [...options.tables] : [];

  if (tables.length === 0) {
    const sql = options.migrationSql || (options.filePath ? fs.readFileSync(options.filePath, 'utf-8') : '');
    if (sql) {
      tables = parseTablesFromSql(sql);
    }
  }

  // If no tables detected, create a placeholder table
  if (tables.length === 0) {
    tables.push({
      tableName: 'entities',
      primaryKey: 'id',
      columns: ['id', 'created_at'],
    });
  }

  const views: GeneratedView[] = tables.map(t => generateTableVirtualView(t, schemaName, baseSchema));

  const routingSql = `SET search_path = "${schemaName}", "${baseSchema}";`;

  const chunks: string[] = [
    `-- ══════════════════════════════════════════════════════════════════════`,
    `-- Virtual Schema: ${schemaName}`,
    `-- Generated by ddlforge v0.9.0 expand engine`,
    `-- ══════════════════════════════════════════════════════════════════════`,
    '',
    `CREATE SCHEMA IF NOT EXISTS "${schemaName}";`,
    '',
  ];

  for (const v of views) {
    chunks.push(`-- ── Table View & INSTEAD OF Triggers: ${v.viewName} ─────────────────`);
    chunks.push(v.fullSql);
    chunks.push('');
  }

  chunks.push(`-- ── Application Connection Routing ──────────────────────────────────`);
  chunks.push(routingSql);
  chunks.push('');

  return {
    version: options.version,
    schemaName,
    routingSql,
    views,
    fullSql: chunks.join('\n'),
  };
}

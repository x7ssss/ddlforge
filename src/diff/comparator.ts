/**
 * ddlforge - Deterministic AST Schema Comparator
 *
 * Compares a normalized live database SchemaGraph against parsed target
 * migration ASTs. Emits structured diff items classified by risk:
 *   - missing: defined in migrations but missing from live DB
 *   - extra: present in live DB but orphaned/untracked in migrations
 *   - changed: column/index/type drift
 *   - unsafe: changes that trigger full table rewrites or heavy locks
 */

import { splitStatements } from '../lexer/sqlTokenizer.js';
import type { Statement, Token } from '../lexer/tokens.js';
import type { CatalogSchema } from './catalog.js';

export type DiffChangeType = 'missing' | 'extra' | 'changed' | 'unsafe';
export type DiffRisk = 'BLOCKER' | 'WARNING' | 'SAFE';

export interface DiffItem {
  entityType: 'table' | 'column' | 'index' | 'constraint' | 'enum' | 'partition';
  name: string;
  table?: string;
  changeType: DiffChangeType;
  risk: DiffRisk;
  description: string;
  detail?: string;
  suggestion?: string;
}

export interface SchemaDiff {
  items: DiffItem[];
  missingCount: number;
  extraCount: number;
  changedCount: number;
  unsafeCount: number;
  hasUnsafe: boolean;
}

export interface GraphColumn {
  name: string;
  dataType: string;
  isNotNull: boolean;
  defaultExpr?: string | null;
  isIdentity?: boolean;
}

export interface GraphIndex {
  name: string;
  table: string;
  isUnique: boolean;
  columns: string[];
  isConcurrent?: boolean;
  predicate?: string | null;
  isValid?: boolean;
}

export interface GraphConstraint {
  name: string;
  table: string;
  type: 'PRIMARY KEY' | 'FOREIGN KEY' | 'UNIQUE' | 'CHECK';
  definition: string;
  isValidated: boolean;
}

export interface GraphPartition {
  parentTable: string;
  childTable: string;
  partitionBound: string;
}

export interface GraphEnum {
  name: string;
  labels: string[];
}

export interface GraphTable {
  name: string;
  columns: Map<string, GraphColumn>;
  isPartitioned?: boolean;
}

export interface SchemaGraph {
  tables: Map<string, GraphTable>;
  indexes: Map<string, GraphIndex>;
  constraints: Map<string, GraphConstraint>;
  partitions: Map<string, GraphPartition>;
  enums: Map<string, GraphEnum>;
}

export function createEmptySchemaGraph(): SchemaGraph {
  return {
    tables: new Map(),
    indexes: new Map(),
    constraints: new Map(),
    partitions: new Map(),
    enums: new Map(),
  };
}

/**
 * Normalizes PostgreSQL data type names for deterministic AST matching.
 */
export function normalizeType(type: string): string {
  let t = type.trim().toLowerCase();
  t = t.replace(/\s+/g, ' ');

  if (t === 'int' || t === 'integer' || t === 'int4') return 'integer';
  if (t === 'bigint' || t === 'int8') return 'bigint';
  if (t === 'smallint' || t === 'int2') return 'smallint';
  if (t === 'bool' || t === 'boolean') return 'boolean';
  if (t.startsWith('varchar') || t.startsWith('character varying')) {
    const len = t.match(/\(\s*(\d+)\s*\)/);
    return len ? `varchar(${len[1]})` : 'varchar';
  }
  if (t === 'text') return 'text';
  if (t.startsWith('timestamp without time zone') || t === 'timestamp') return 'timestamp';
  if (t.startsWith('timestamp with time zone') || t === 'timestamptz') return 'timestamptz';
  if (t === 'double precision' || t === 'float8') return 'double precision';
  if (t === 'real' || t === 'float4') return 'real';
  if (t.startsWith('numeric') || t.startsWith('decimal')) {
    const m = t.match(/\(\s*(\d+(?:\s*,\s*\d+)?)\s*\)/);
    return m ? `numeric(${m[1].replace(/\s+/g, '')})` : 'numeric';
  }

  return t;
}

/**
 * Robustly parses a column definition string e.g.:
 *   "col_name integer NOT NULL DEFAULT 1"
 *   "bio text"
 *   "total numeric(12,2) NOT NULL"
 */
function extractColumnDef(text: string): {
  colName: string;
  colType: string;
  isNotNull: boolean;
  isIdentity: boolean;
  defaultExpr: string | null;
} | null {
  const trimmed = text.trim().replace(/;$/, '');
  const m = trimmed.match(/^([a-zA-Z0-9_"]+)\s+(.+)$/s);
  if (!m) return null;

  const colName = m[1].replace(/["`]/g, '');
  const remaining = m[2].trim();

  let rawType = '';
  let rest = '';

  // Multi-word PostgreSQL types
  const multiWordMatch = remaining.match(/^(character\s+varying(?:\s*\([^)]*\))?|timestamp(?:\s+(?:without|with)\s+time\s+zone)?|time(?:\s+(?:without|with)\s+time\s+zone)?|double\s+precision)/i);
  if (multiWordMatch) {
    rawType = multiWordMatch[1];
    rest = remaining.slice(multiWordMatch[0].length);
  } else {
    // Single token possibly with parens e.g. numeric(12,2) or varchar(50)
    const singleMatch = remaining.match(/^([a-zA-Z0-9_]+(?:\s*\([^)]*\))?(?:\[\])?)(.*)$/s);
    if (singleMatch) {
      rawType = singleMatch[1];
      rest = singleMatch[2];
    } else {
      rawType = remaining;
      rest = '';
    }
  }

  const colType = normalizeType(rawType);
  const restUpper = rest.toUpperCase();

  const isNotNull = restUpper.includes('NOT NULL');
  const isIdentity = restUpper.includes('GENERATED ALWAYS') || restUpper.includes('GENERATED BY DEFAULT');

  let defaultExpr: string | null = null;
  const defMatch = rest.match(/DEFAULT\s+([^,;]+?)(?:\s+NOT|\s+NULL|\s+REFERENCES|\s+PRIMARY|\s+UNIQUE|\s+CHECK|$)/i);
  if (defMatch) {
    defaultExpr = defMatch[1].trim();
  }

  return { colName, colType, isNotNull, isIdentity, defaultExpr };
}

/**
 * Converts live CatalogSchema snapshot into normalized SchemaGraph.
 */
export function catalogToSchemaGraph(catalog: CatalogSchema): SchemaGraph {
  const graph = createEmptySchemaGraph();

  // Tables & Columns
  for (const tbl of catalog.tables) {
    const tableKey = tbl.name.toLowerCase();
    const gTable: GraphTable = {
      name: tbl.name,
      columns: new Map(),
      isPartitioned: tbl.isPartitioned,
    };

    for (const col of tbl.columns) {
      gTable.columns.set(col.name.toLowerCase(), {
        name: col.name,
        dataType: normalizeType(col.dataType),
        isNotNull: col.isNotNull,
        defaultExpr: col.defaultExpr,
        isIdentity: Boolean(col.identityType),
      });
    }
    graph.tables.set(tableKey, gTable);
  }

  // Indexes
  for (const idx of catalog.indexes) {
    const idxKey = idx.name.toLowerCase();
    // Extract column list from index def
    const parenMatch = idx.indexDef.match(/\(([^)]+)\)/);
    const cols = parenMatch ? parenMatch[1].split(',').map(c => c.trim().replace(/["`]/g, '')) : [];

    graph.indexes.set(idxKey, {
      name: idx.name,
      table: idx.table,
      isUnique: idx.isUnique,
      columns: cols,
      predicate: idx.predicate,
      isValid: idx.isValid,
    });
  }

  // Constraints
  for (const con of catalog.constraints) {
    const conKey = `${con.table.toLowerCase()}.${con.name.toLowerCase()}`;
    let cType: GraphConstraint['type'] = 'CHECK';
    if (con.type === 'p') cType = 'PRIMARY KEY';
    else if (con.type === 'u') cType = 'UNIQUE';
    else if (con.type === 'f') cType = 'FOREIGN KEY';

    graph.constraints.set(conKey, {
      name: con.name,
      table: con.table,
      type: cType,
      definition: con.definition,
      isValidated: con.isValidated,
    });
  }

  // Partitions
  for (const p of catalog.partitions) {
    const pKey = `${p.parentTable.toLowerCase()}->${p.childTable.toLowerCase()}`;
    graph.partitions.set(pKey, {
      parentTable: p.parentTable,
      childTable: p.childTable,
      partitionBound: p.partitionBound,
    });
  }

  // Enums
  for (const e of catalog.enums) {
    const eKey = e.name.toLowerCase();
    graph.enums.set(eKey, {
      name: e.name,
      labels: [...e.labels],
    });
  }

  return graph;
}

/**
 * Builds a normalized SchemaGraph from SQL DDL statements.
 */
export function buildSchemaGraphFromSql(sql: string): SchemaGraph {
  const graph = createEmptySchemaGraph();
  const statements: Statement[] = splitStatements(sql);

  for (const stmt of statements) {
    const tokens = stmt.tokens;
    if (tokens.length < 2) continue;

    const t0 = tokens[0].value;
    const t1 = tokens[1].value;

    // 1. CREATE TABLE [IF NOT EXISTS] <table> (...)
    if (t0 === 'CREATE' && t1 === 'TABLE') {
      parseCreateTable(stmt, graph);
      continue;
    }

    // 2. ALTER TABLE <table> ...
    if (t0 === 'ALTER' && t1 === 'TABLE') {
      parseAlterTable(stmt, graph);
      continue;
    }

    // 3. CREATE [UNIQUE] INDEX [CONCURRENTLY] <name> ON <table> (...)
    if (t0 === 'CREATE' && (t1 === 'INDEX' || (t1 === 'UNIQUE' && tokens[2]?.value === 'INDEX'))) {
      parseCreateIndex(stmt, graph);
      continue;
    }

    // 4. CREATE TYPE <name> AS ENUM (...)
    if (t0 === 'CREATE' && t1 === 'TYPE') {
      parseCreateEnum(stmt, graph);
      continue;
    }

    // 5. DROP TABLE [IF EXISTS] <table>
    if (t0 === 'DROP' && t1 === 'TABLE') {
      let idx = 2;
      if (tokens[idx]?.value === 'IF' && tokens[idx + 1]?.value === 'EXISTS') idx += 2;
      const tableName = tokens[idx]?.raw?.replace(/["`]/g, '');
      if (tableName) {
        graph.tables.delete(tableName.toLowerCase());
      }
      continue;
    }

    // 6. DROP INDEX [CONCURRENTLY] [IF EXISTS] <name>
    if (t0 === 'DROP' && t1 === 'INDEX') {
      let idx = 2;
      if (tokens[idx]?.value === 'CONCURRENTLY') idx++;
      if (tokens[idx]?.value === 'IF' && tokens[idx + 1]?.value === 'EXISTS') idx += 2;
      const indexName = tokens[idx]?.raw?.replace(/["`]/g, '');
      if (indexName) {
        graph.indexes.delete(indexName.toLowerCase());
      }
      continue;
    }
  }

  return graph;
}

function parseCreateTable(stmt: Statement, graph: SchemaGraph): void {
  const tokens = stmt.tokens;
  let idx = 2;
  if (tokens[idx]?.value === 'IF' && tokens[idx + 1]?.value === 'NOT' && tokens[idx + 2]?.value === 'EXISTS') {
    idx += 3;
  }
  const rawTableName = tokens[idx]?.raw;
  if (!rawTableName) return;
  const tableName = rawTableName.replace(/["`]/g, '');
  const tableKey = tableName.toLowerCase();

  const isPartitioned = stmt.raw.toUpperCase().includes('PARTITION BY');

  const gTable: GraphTable = {
    name: tableName,
    columns: new Map(),
    isPartitioned,
  };

  const parenStart = stmt.raw.indexOf('(');
  const parenEnd = stmt.raw.lastIndexOf(')');
  if (parenStart !== -1 && parenEnd !== -1 && parenEnd > parenStart) {
    const body = stmt.raw.slice(parenStart + 1, parenEnd);
    const colDefs = splitTopLevelCommas(body);

    for (const def of colDefs) {
      const trimmed = def.trim();
      if (!trimmed) continue;
      const upper = trimmed.toUpperCase();

      // Check for table-level constraints
      if (upper.startsWith('CONSTRAINT') || upper.startsWith('PRIMARY KEY') || upper.startsWith('FOREIGN KEY') || upper.startsWith('UNIQUE') || upper.startsWith('CHECK')) {
        parseInlineTableConstraint(tableName, trimmed, graph);
        continue;
      }

      // Column definition: <name> <type> [NOT NULL] [DEFAULT <expr>] ...
      const colDef = extractColumnDef(trimmed);
      if (colDef) {
        gTable.columns.set(colDef.colName.toLowerCase(), {
          name: colDef.colName,
          dataType: colDef.colType,
          isNotNull: colDef.isNotNull,
          defaultExpr: colDef.defaultExpr,
          isIdentity: colDef.isIdentity,
        });
      }
    }
  }

  graph.tables.set(tableKey, gTable);
}

function parseAlterTable(stmt: Statement, graph: SchemaGraph): void {
  const tokens = stmt.tokens;
  let idx = 2;
  while (idx < tokens.length) {
    if (tokens[idx]?.value === 'IF' && tokens[idx + 1]?.value === 'EXISTS') { idx += 2; continue; }
    if (tokens[idx]?.value === 'ONLY') { idx++; continue; }
    break;
  }
  const rawTableName = tokens[idx]?.raw;
  if (!rawTableName) return;
  const tableName = rawTableName.replace(/["`]/g, '');
  const tableKey = tableName.toLowerCase();

  let gTable = graph.tables.get(tableKey);
  if (!gTable) {
    gTable = { name: tableName, columns: new Map() };
    graph.tables.set(tableKey, gTable);
  }

  const rawUpper = stmt.raw.toUpperCase();

  // ATTACH PARTITION
  if (rawUpper.includes('ATTACH PARTITION')) {
    const attachMatch = stmt.raw.match(/ATTACH\s+PARTITION\s+([a-zA-Z0-9_"]+)\s+FOR\s+VALUES\s+(.+)$/i);
    if (attachMatch) {
      const childTable = attachMatch[1].replace(/["`]/g, '');
      const bound = attachMatch[2].trim().replace(/;$/, '');
      const pKey = `${tableName.toLowerCase()}->${childTable.toLowerCase()}`;
      graph.partitions.set(pKey, {
        parentTable: tableName,
        childTable,
        partitionBound: bound,
      });
    }
    return;
  }

  // ADD [COLUMN] <col> <type> ...
  const addMatch = stmt.raw.match(/ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(.+)$/i);
  if (addMatch && !rawUpper.includes('ADD CONSTRAINT') && !rawUpper.includes('ADD PRIMARY KEY') && !rawUpper.includes('ADD FOREIGN KEY') && !rawUpper.includes('ADD UNIQUE') && !rawUpper.includes('ADD CHECK')) {
    const colDef = extractColumnDef(addMatch[1]);
    if (colDef) {
      gTable.columns.set(colDef.colName.toLowerCase(), {
        name: colDef.colName,
        dataType: colDef.colType,
        isNotNull: colDef.isNotNull,
        defaultExpr: colDef.defaultExpr,
        isIdentity: colDef.isIdentity,
      });
      return;
    }
  }

  // DROP [COLUMN] <col>
  const dropColMatch = stmt.raw.match(/DROP\s+(?:COLUMN\s+)?(?:IF\s+EXISTS\s+)?([a-zA-Z0-9_"]+)/i);
  if (dropColMatch && !rawUpper.includes('DROP CONSTRAINT')) {
    const colName = dropColMatch[1].replace(/["`]/g, '');
    gTable.columns.delete(colName.toLowerCase());
    return;
  }

  // ALTER [COLUMN] <col> TYPE <newtype>
  const alterTypeMatch = stmt.raw.match(/ALTER\s+(?:COLUMN\s+)?([a-zA-Z0-9_"]+)\s+(?:SET\s+DATA\s+)?TYPE\s+(.+)$/i);
  if (alterTypeMatch) {
    const colName = alterTypeMatch[1].replace(/["`]/g, '');
    const cleanTypePart = alterTypeMatch[2].trim().replace(/;$/, '').replace(/\s+USING\s+.+$/i, '');
    const newType = normalizeType(cleanTypePart);
    const existing = gTable.columns.get(colName.toLowerCase());
    if (existing) {
      existing.dataType = newType;
    } else {
      gTable.columns.set(colName.toLowerCase(), {
        name: colName,
        dataType: newType,
        isNotNull: false,
      });
    }
    return;
  }

  // ADD CONSTRAINT <name> ...
  if (rawUpper.includes('ADD CONSTRAINT') || rawUpper.includes('ADD CHECK') || rawUpper.includes('ADD FOREIGN KEY')) {
    const isNotValid = rawUpper.includes('NOT VALID');
    let conName = `con_${tableName}_${Math.random().toString(36).slice(2, 7)}`;
    const nameMatch = stmt.raw.match(/ADD\s+CONSTRAINT\s+([a-zA-Z0-9_"]+)/i);
    if (nameMatch) {
      conName = nameMatch[1].replace(/["`]/g, '');
    }

    let cType: GraphConstraint['type'] = 'CHECK';
    if (rawUpper.includes('PRIMARY KEY')) cType = 'PRIMARY KEY';
    else if (rawUpper.includes('FOREIGN KEY')) cType = 'FOREIGN KEY';
    else if (rawUpper.includes('UNIQUE')) cType = 'UNIQUE';

    const conKey = `${tableName.toLowerCase()}.${conName.toLowerCase()}`;
    graph.constraints.set(conKey, {
      name: conName,
      table: tableName,
      type: cType,
      definition: stmt.raw.trim(),
      isValidated: !isNotValid,
    });
    return;
  }

  // VALIDATE CONSTRAINT <name>
  if (rawUpper.includes('VALIDATE CONSTRAINT')) {
    const valMatch = stmt.raw.match(/VALIDATE\s+CONSTRAINT\s+([a-zA-Z0-9_"]+)/i);
    if (valMatch) {
      const conName = valMatch[1].replace(/["`]/g, '');
      const conKey = `${tableName.toLowerCase()}.${conName.toLowerCase()}`;
      const con = graph.constraints.get(conKey);
      if (con) {
        con.isValidated = true;
      }
    }
  }
}

function parseInlineTableConstraint(tableName: string, trimmed: string, graph: SchemaGraph): void {
  const upper = trimmed.toUpperCase();
  let conName = `pk_${tableName}`;
  const nameMatch = trimmed.match(/CONSTRAINT\s+([a-zA-Z0-9_"]+)/i);
  if (nameMatch) {
    conName = nameMatch[1].replace(/["`]/g, '');
  }

  let cType: GraphConstraint['type'] = 'CHECK';
  if (upper.includes('PRIMARY KEY')) cType = 'PRIMARY KEY';
  else if (upper.includes('FOREIGN KEY') || upper.includes('REFERENCES')) cType = 'FOREIGN KEY';
  else if (upper.includes('UNIQUE')) cType = 'UNIQUE';

  const isNotValid = upper.includes('NOT VALID');

  const conKey = `${tableName.toLowerCase()}.${conName.toLowerCase()}`;
  graph.constraints.set(conKey, {
    name: conName,
    table: tableName,
    type: cType,
    definition: trimmed,
    isValidated: !isNotValid,
  });
}

function parseCreateIndex(stmt: Statement, graph: SchemaGraph): void {
  const upper = stmt.raw.toUpperCase();
  const isUnique = upper.includes('UNIQUE');
  const isConcurrent = upper.includes('CONCURRENTLY');

  // Extract index name and table name
  const m = stmt.raw.match(/INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z0-9_"]+)\s+ON\s+(?:ONLY\s+)?([a-zA-Z0-9_"]+)/i);
  if (!m) return;

  const indexName = m[1].replace(/["`]/g, '');
  const tableName = m[2].replace(/["`]/g, '');

  const parenMatch = stmt.raw.match(/\(([^)]+)\)/);
  const cols = parenMatch ? parenMatch[1].split(',').map(c => c.trim().replace(/["`]/g, '')) : [];

  let predicate: string | null = null;
  const whereMatch = stmt.raw.match(/WHERE\s+(.+)$/i);
  if (whereMatch) {
    predicate = whereMatch[1].trim().replace(/;$/, '');
  }

  graph.indexes.set(indexName.toLowerCase(), {
    name: indexName,
    table: tableName,
    isUnique,
    columns: cols,
    isConcurrent,
    predicate,
    isValid: true,
  });
}

function parseCreateEnum(stmt: Statement, graph: SchemaGraph): void {
  const m = stmt.raw.match(/CREATE\s+TYPE\s+([a-zA-Z0-9_"]+)\s+AS\s+ENUM\s*\(([^)]+)\)/i);
  if (!m) return;

  const enumName = m[1].replace(/["`]/g, '');
  const labels = m[2].split(',').map(s => s.trim().replace(/['"]/g, ''));

  graph.enums.set(enumName.toLowerCase(), {
    name: enumName,
    labels,
  });
}

function splitTopLevelCommas(input: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let cur = '';

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      cur += ch;
      continue;
    }
    if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      cur += ch;
      continue;
    }
    if (!inSingleQuote && !inDoubleQuote) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if (ch === ',' && depth === 0) {
        parts.push(cur);
        cur = '';
        continue;
      }
    }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

/**
 * Compares a live database SchemaGraph against a target migration SchemaGraph.
 *
 * Categorizes differences into:
 *   - missing: defined in target, absent in live
 *   - extra: present in live, absent in target
 *   - changed: existing entity has drifted configuration
 *   - unsafe: changes that trigger full table rewrites or heavy lock contention
 */
export function compareSchemas(live: SchemaGraph, target: SchemaGraph): SchemaDiff {
  const items: DiffItem[] = [];

  // 1. Table diffs
  for (const [tKey, targetTable] of target.tables) {
    const liveTable = live.tables.get(tKey);
    if (!liveTable) {
      items.push({
        entityType: 'table',
        name: targetTable.name,
        changeType: 'missing',
        risk: 'WARNING',
        description: `Table "${targetTable.name}" exists in target migrations but is missing in live database.`,
        suggestion: `Apply migration creating table "${targetTable.name}".`,
      });
      continue;
    }

    // Column diffs within existing table
    for (const [cKey, targetCol] of targetTable.columns) {
      const liveCol = liveTable.columns.get(cKey);
      if (!liveCol) {
        // Adding NOT NULL column without DEFAULT to existing populated table is UNSAFE!
        if (targetCol.isNotNull && !targetCol.defaultExpr) {
          items.push({
            entityType: 'column',
            name: `${targetTable.name}.${targetCol.name}`,
            table: targetTable.name,
            changeType: 'unsafe',
            risk: 'BLOCKER',
            description: `Adding NOT NULL column "${targetCol.name}" to table "${targetTable.name}" without DEFAULT causes full table lock and duplicate scan hazard.`,
            suggestion: `Add column as nullable, backfill values, then add NOT NULL constraint or use a default.`,
          });
        } else {
          items.push({
            entityType: 'column',
            name: `${targetTable.name}.${targetCol.name}`,
            table: targetTable.name,
            changeType: 'missing',
            risk: 'WARNING',
            description: `Column "${targetCol.name}" (${targetCol.dataType}) missing from table "${targetTable.name}".`,
          });
        }
        continue;
      }

      // Column drift (type change)
      if (liveCol.dataType !== targetCol.dataType) {
        items.push({
          entityType: 'column',
          name: `${targetTable.name}.${targetCol.name}`,
          table: targetTable.name,
          changeType: 'unsafe',
          risk: 'BLOCKER',
          description: `Column "${targetTable.name}.${targetCol.name}" type differs: live is "${liveCol.dataType}", target is "${targetCol.dataType}". Altering type requires ACCESS EXCLUSIVE lock and physical table rewrite.`,
          suggestion: `Follow expand/contract pattern: add new column, dual-write, backfill, and swap.`,
        });
      } else if (liveCol.isNotNull !== targetCol.isNotNull) {
        items.push({
          entityType: 'column',
          name: `${targetTable.name}.${targetCol.name}`,
          table: targetTable.name,
          changeType: 'changed',
          risk: 'WARNING',
          description: `Column "${targetTable.name}.${targetCol.name}" nullability differs: live is ${liveCol.isNotNull ? 'NOT NULL' : 'NULL'}, target is ${targetCol.isNotNull ? 'NOT NULL' : 'NULL'}.`,
        });
      }
    }

    // Check for extra columns in live DB
    for (const [cKey, liveCol] of liveTable.columns) {
      if (!targetTable.columns.has(cKey)) {
        items.push({
          entityType: 'column',
          name: `${liveTable.name}.${liveCol.name}`,
          table: liveTable.name,
          changeType: 'extra',
          risk: 'SAFE',
          description: `Column "${liveTable.name}.${liveCol.name}" exists in live database but is not declared in target migrations (orphaned).`,
        });
      }
    }
  }

  // Extra tables in live DB
  for (const [tKey, liveTable] of live.tables) {
    if (!target.tables.has(tKey)) {
      items.push({
        entityType: 'table',
        name: liveTable.name,
        changeType: 'extra',
        risk: 'WARNING',
        description: `Table "${liveTable.name}" exists in live database but is not present in target migrations (orphaned table).`,
      });
    }
  }

  // 2. Index diffs
  for (const [iKey, targetIdx] of target.indexes) {
    const liveIdx = live.indexes.get(iKey);
    if (!liveIdx) {
      if (targetIdx.isConcurrent === false) {
        items.push({
          entityType: 'index',
          name: targetIdx.name,
          table: targetIdx.table,
          changeType: 'unsafe',
          risk: 'BLOCKER',
          description: `Index "${targetIdx.name}" on table "${targetIdx.table}" missing in live DB and lacks CONCURRENTLY keyword (blocks writes).`,
          suggestion: `Add CONCURRENTLY modifier to CREATE INDEX.`,
        });
      } else {
        items.push({
          entityType: 'index',
          name: targetIdx.name,
          table: targetIdx.table,
          changeType: 'missing',
          risk: 'WARNING',
          description: `Index "${targetIdx.name}" on table "${targetIdx.table}" missing in live database.`,
        });
      }
    } else if (liveIdx.isValid === false) {
      items.push({
        entityType: 'index',
        name: targetIdx.name,
        table: targetIdx.table,
        changeType: 'unsafe',
        risk: 'BLOCKER',
        description: `Index "${targetIdx.name}" in live database is marked INVALID (indisvalid=false). It cannot be used by queries.`,
        suggestion: `Drop invalid index concurrently and rebuild with CREATE INDEX CONCURRENTLY.`,
      });
    }
  }

  // Extra indexes in live DB
  for (const [iKey, liveIdx] of live.indexes) {
    if (!target.indexes.has(iKey)) {
      items.push({
        entityType: 'index',
        name: liveIdx.name,
        table: liveIdx.table,
        changeType: 'extra',
        risk: 'SAFE',
        description: `Index "${liveIdx.name}" exists in live database but is not in target migrations.`,
      });
    }
  }

  // 3. Constraint diffs
  for (const [cKey, targetCon] of target.constraints) {
    const liveCon = live.constraints.get(cKey);
    if (!liveCon) {
      if (!targetCon.isValidated) {
        items.push({
          entityType: 'constraint',
          name: targetCon.name,
          table: targetCon.table,
          changeType: 'missing',
          risk: 'SAFE',
          description: `Constraint "${targetCon.name}" (${targetCon.type}) missing in live DB (correctly declared NOT VALID).`,
        });
      } else {
        items.push({
          entityType: 'constraint',
          name: targetCon.name,
          table: targetCon.table,
          changeType: 'unsafe',
          risk: 'BLOCKER',
          description: `Constraint "${targetCon.name}" (${targetCon.type}) on table "${targetCon.table}" missing in live DB and added without NOT VALID (scans entire table synchronously under lock).`,
          suggestion: `Add constraint with NOT VALID, then run VALIDATE CONSTRAINT in a separate transaction.`,
        });
      }
    } else if (!liveCon.isValidated && targetCon.isValidated) {
      items.push({
        entityType: 'constraint',
        name: targetCon.name,
        table: targetCon.table,
        changeType: 'changed',
        risk: 'WARNING',
        description: `Constraint "${targetCon.name}" on table "${targetCon.table}" is unvalidated in live DB (NOT VALID).`,
        suggestion: `Run ALTER TABLE "${targetCon.table}" VALIDATE CONSTRAINT "${targetCon.name}";`,
      });
    }
  }

  // 4. Enum diffs
  for (const [eKey, targetEnum] of target.enums) {
    const liveEnum = live.enums.get(eKey);
    if (!liveEnum) {
      items.push({
        entityType: 'enum',
        name: targetEnum.name,
        changeType: 'missing',
        risk: 'WARNING',
        description: `Enum type "${targetEnum.name}" missing in live database.`,
      });
    } else {
      const missingLabels = targetEnum.labels.filter(l => !liveEnum.labels.includes(l));
      if (missingLabels.length > 0) {
        items.push({
          entityType: 'enum',
          name: targetEnum.name,
          changeType: 'changed',
          risk: 'WARNING',
          description: `Enum "${targetEnum.name}" in live DB is missing labels: ${missingLabels.join(', ')}.`,
          suggestion: missingLabels.map(l => `ALTER TYPE ${targetEnum.name} ADD VALUE '${l}';`).join(' '),
        });
      }
    }
  }

  const missingCount = items.filter(i => i.changeType === 'missing').length;
  const extraCount = items.filter(i => i.changeType === 'extra').length;
  const changedCount = items.filter(i => i.changeType === 'changed').length;
  const unsafeCount = items.filter(i => i.changeType === 'unsafe').length;
  const hasUnsafe = unsafeCount > 0;

  return {
    items,
    missingCount,
    extraCount,
    changedCount,
    unsafeCount,
    hasUnsafe,
  };
}

/**
 * Colorizes and formats SchemaDiff for terminal stdout.
 */
export function formatDiffTerminal(diff: SchemaDiff, useColor = true): string {
  const c = {
    reset: useColor ? '\x1b[0m' : '',
    bold: useColor ? '\x1b[1m' : '',
    dim: useColor ? '\x1b[2m' : '',
    red: useColor ? '\x1b[31m' : '',
    green: useColor ? '\x1b[32m' : '',
    yellow: useColor ? '\x1b[33m' : '',
    cyan: useColor ? '\x1b[36m' : '',
    gray: useColor ? '\x1b[90m' : '',
    bgRed: useColor ? '\x1b[41m\x1b[37m' : '',
    bgYellow: useColor ? '\x1b[43m\x1b[30m' : '',
  };

  const lines: string[] = [];
  lines.push('');
  lines.push(`${c.bold}${c.cyan}=== ddlforge Live Schema Drift Analysis ===${c.reset}`);
  lines.push(c.gray + '─'.repeat(70) + c.reset);

  if (diff.items.length === 0) {
    lines.push(`${c.green}${c.bold}✔ SYNCHRONIZED:${c.reset} Live database matches target migration schema perfectly.`);
    lines.push('');
    return lines.join('\n');
  }

  for (const item of diff.items) {
    let badge = '';
    if (item.changeType === 'unsafe') {
      badge = `${c.bgRed} UNSAFE ${c.reset}`;
    } else if (item.changeType === 'missing') {
      badge = `${c.yellow}[MISSING]${c.reset}`;
    } else if (item.changeType === 'extra') {
      badge = `${c.gray}[ORPHANED]${c.reset}`;
    } else {
      badge = `${c.cyan}[CHANGED]${c.reset}`;
    }

    lines.push(`${badge} ${c.bold}${item.entityType.toUpperCase()}: ${item.name}${c.reset}`);
    lines.push(`   ${item.description}`);
    if (item.suggestion) {
      lines.push(`   ${c.green}Fix: ${item.suggestion}${c.reset}`);
    }
    lines.push('');
  }

  lines.push(c.gray + '━'.repeat(70) + c.reset);
  lines.push(
    `Summary: ${diff.unsafeCount > 0 ? c.red : c.green}${diff.unsafeCount} unsafe${c.reset}, ` +
    `${diff.missingCount} missing, ${diff.changedCount} changed, ${diff.extraCount} orphaned.`
  );

  if (diff.hasUnsafe) {
    lines.push(`${c.red}${c.bold}✖ FAILED:${c.reset} Unsafe drift detected that could cause downtime or physical table rewrites.`);
  } else {
    lines.push(`${c.green}${c.bold}✔ SAFE DRIFT:${c.reset} No dangerous locking operations detected.`);
  }

  return lines.join('\n');
}

/**
 * Formats SchemaDiff as JSON.
 */
export function formatDiffJson(diff: SchemaDiff): string {
  return JSON.stringify(diff, null, 2);
}

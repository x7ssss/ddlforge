/**
 * ddlforge - Cross-Tenant Schema Drift Auditor
 *
 * Implements deterministic schema fingerprinting and cross-tenant drift detection:
 * 1. Introspects catalog definitions (columns, types, constraints with pg_get_expr, and indexes).
 * 2. Computes normalized canonical SHA-256 fingerprint per tenant schema.
 * 3. Identifies "Golden" schema via consensus majority or explicit target (`--golden <name>`).
 * 4. Flags "Snowflake" drifted tenants and generates zero-downtime reconciliation SQL:
 *    - Missing indexes -> `CREATE INDEX CONCURRENTLY`
 *    - Missing constraints -> `ALTER TABLE ... ADD CONSTRAINT ... NOT VALID` + `VALIDATE CONSTRAINT`
 *    - Missing columns -> `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`
 */

import { createHash } from 'node:crypto';
import type { PgClientLike } from '../cluster/advisory.js';
import type { TenantTarget } from './tenantRouter.js';

export interface NormalizedColumn {
  name: string;
  dataType: string;
  isNotNull: boolean;
  defaultExpr: string | null;
}

export interface NormalizedIndex {
  name: string;
  table: string;
  isUnique: boolean;
  accessMethod: string;
  definition: string;
}

export interface NormalizedConstraint {
  name: string;
  table: string;
  type: 'p' | 'u' | 'c' | 'f';
  definition: string;
  isValidated: boolean;
}

export interface NormalizedTable {
  name: string;
  columns: NormalizedColumn[];
}

export interface NormalizedTenantSchema {
  tenantId: string;
  tenantName: string;
  schema: string;
  tables: NormalizedTable[];
  indexes: NormalizedIndex[];
  constraints: NormalizedConstraint[];
}

export interface TenantDriftProfile {
  tenantId: string;
  tenantName: string;
  schema: string;
  fingerprint: string;
  isGolden: boolean;
  isDrifted: boolean;
  missingColumns: Array<{ table: string; column: string; type: string; defaultExpr: string | null }>;
  missingIndexes: Array<{ table: string; index: string; definition: string }>;
  missingConstraints: Array<{ table: string; constraint: string; definition: string }>;
  extraColumns: Array<{ table: string; column: string }>;
  extraIndexes: Array<{ table: string; index: string }>;
  reconciliationSql: string;
}

export interface CrossTenantDriftReport {
  totalTenants: number;
  driftedCount: number;
  goldenTenant: string;
  goldenFingerprint: string;
  fingerprintGroups: Record<string, string[]>; // fingerprint -> tenant names
  profiles: TenantDriftProfile[];
  checkedAt: Date;
}

export interface AuditDriftOptions {
  goldenTenant?: string; // Optional explicit golden tenant name/schema
  schemasToAudit?: string[];
}

/**
 * Normalizes index definition by stripping schema qualifiers and whitespace.
 * e.g. "CREATE INDEX idx_users_email ON tenant_001.users USING btree (email)"
 * -> "CREATE INDEX idx_users_email ON users USING btree (email)"
 */
export function normalizeIndexDef(def: string, schemaName?: string): string {
  let cleaned = def.trim().replace(/\s+/g, ' ');
  if (schemaName) {
    const escaped = schemaName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    cleaned = cleaned.replace(new RegExp(`"${escaped}"\\.`, 'gi'), '');
    cleaned = cleaned.replace(new RegExp(`\\b${escaped}\\.`, 'gi'), '');
  }
  return cleaned;
}

/**
 * Generates a deterministic SHA-256 fingerprint from a normalized tenant schema.
 * Note: schema and tenantId are deliberately excluded so schemas with different names
 * but identical table/column/index/constraint definitions share the same fingerprint.
 */
export function calculateSchemaFingerprint(schema: NormalizedTenantSchema): string {
  // 1. Sort tables and columns
  const sortedTables = [...schema.tables]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(t => ({
      name: t.name,
      columns: [...t.columns].sort((a, b) => a.name.localeCompare(b.name)),
    }));

  // 2. Sort indexes
  const sortedIndexes = [...schema.indexes]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(idx => ({
      name: idx.name,
      table: idx.table,
      isUnique: idx.isUnique,
      accessMethod: idx.accessMethod,
      definition: normalizeIndexDef(idx.definition, schema.schema),
    }));

  // 3. Sort constraints
  const sortedConstraints = [...schema.constraints]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(c => ({
      name: c.name,
      table: c.table,
      type: c.type,
      definition: c.definition.trim().replace(/\s+/g, ' '),
    }));

  const canonicalPayload = JSON.stringify({
    tables: sortedTables,
    indexes: sortedIndexes,
    constraints: sortedConstraints,
  });

  return createHash('sha256').update(canonicalPayload, 'utf-8').digest('hex');
}

/**
 * Generates zero-downtime lock-safe reconciliation SQL to transition a drifted tenant to the golden schema.
 */
export function generateReconciliationSql(
  targetSchema: string,
  missingColumns: Array<{ table: string; column: string; type: string; defaultExpr: string | null }>,
  missingIndexes: Array<{ table: string; index: string; definition: string }>,
  missingConstraints: Array<{ table: string; constraint: string; definition: string }>
): string {
  const statements: string[] = [];

  // 1. Missing columns: ADD COLUMN IF NOT EXISTS
  for (const col of missingColumns) {
    let colDef = `ALTER TABLE "${targetSchema}"."${col.table}" ADD COLUMN IF NOT EXISTS "${col.column}" ${col.type}`;
    if (col.defaultExpr) {
      colDef += ` DEFAULT ${col.defaultExpr}`;
    }
    colDef += ';';
    statements.push(colDef);
  }

  // 2. Missing indexes: CREATE INDEX CONCURRENTLY
  for (const idx of missingIndexes) {
    // Inject CONCURRENTLY and target schema qualifier
    let sql = idx.definition.trim();
    if (!sql.endsWith(';')) sql += ';';

    // Replace "CREATE INDEX " with "CREATE INDEX CONCURRENTLY " (if not already concurrent)
    if (!/CREATE\s+(UNIQUE\s+)?INDEX\s+CONCURRENTLY/i.test(sql)) {
      sql = sql.replace(/CREATE\s+(UNIQUE\s+)?INDEX/i, (m, u) => `CREATE ${u ? 'UNIQUE ' : ''}INDEX CONCURRENTLY`);
    }

    // Ensure table in index definition references targetSchema (stripping any existing schema prefix)
    const tableRegex = new RegExp(`\\bON\\s+(?:"?[^."\\s]+"\\.)?(?:"?${idx.table}"?)`, 'i');
    sql = sql.replace(tableRegex, `ON "${targetSchema}"."${idx.table}"`);

    statements.push(sql);
  }

  // 3. Missing constraints: ADD CONSTRAINT ... NOT VALID followed by VALIDATE CONSTRAINT
  for (const con of missingConstraints) {
    const addStmt = `ALTER TABLE "${targetSchema}"."${con.table}" ADD CONSTRAINT "${con.constraint}" ${con.definition} NOT VALID;`;
    const valStmt = `ALTER TABLE "${targetSchema}"."${con.table}" VALIDATE CONSTRAINT "${con.constraint}";`;
    statements.push(addStmt);
    statements.push(valStmt);
  }

  return statements.join('\n');
}

/**
 * Compares a drifted tenant's schema against a reference golden schema and produces diffs & patches.
 */
export function compareTenantToGolden(
  tenant: NormalizedTenantSchema,
  golden: NormalizedTenantSchema
): TenantDriftProfile {
  const tenantFp = calculateSchemaFingerprint(tenant);
  const goldenFp = calculateSchemaFingerprint(golden);
  const isDrifted = tenantFp !== goldenFp;

  const missingColumns: Array<{ table: string; column: string; type: string; defaultExpr: string | null }> = [];
  const extraColumns: Array<{ table: string; column: string }> = [];
  const missingIndexes: Array<{ table: string; index: string; definition: string }> = [];
  const extraIndexes: Array<{ table: string; index: string }> = [];
  const missingConstraints: Array<{ table: string; constraint: string; definition: string }> = [];

  // 1. Column comparison
  const goldenTableMap = new Map(golden.tables.map(t => [t.name, t]));
  const tenantTableMap = new Map(tenant.tables.map(t => [t.name, t]));

  for (const [tName, gTbl] of goldenTableMap.entries()) {
    const tTbl = tenantTableMap.get(tName);
    if (!tTbl) {
      // Entire table missing from tenant
      for (const col of gTbl.columns) {
        missingColumns.push({ table: tName, column: col.name, type: col.dataType, defaultExpr: col.defaultExpr });
      }
    } else {
      const tColMap = new Map(tTbl.columns.map(c => [c.name, c]));
      for (const gCol of gTbl.columns) {
        if (!tColMap.has(gCol.name)) {
          missingColumns.push({ table: tName, column: gCol.name, type: gCol.dataType, defaultExpr: gCol.defaultExpr });
        }
      }
      for (const tCol of tTbl.columns) {
        if (!gTbl.columns.some(c => c.name === tCol.name)) {
          extraColumns.push({ table: tName, column: tCol.name });
        }
      }
    }
  }

  // 2. Index comparison
  const goldenIdxMap = new Map(golden.indexes.map(i => [i.name, i]));
  const tenantIdxMap = new Map(tenant.indexes.map(i => [i.name, i]));

  for (const [idxName, gIdx] of goldenIdxMap.entries()) {
    if (!tenantIdxMap.has(idxName)) {
      missingIndexes.push({ table: gIdx.table, index: idxName, definition: gIdx.definition });
    }
  }
  for (const [idxName, tIdx] of tenantIdxMap.entries()) {
    if (!goldenIdxMap.has(idxName)) {
      extraIndexes.push({ table: tIdx.table, index: idxName });
    }
  }

  // 3. Constraint comparison
  const goldenConMap = new Map(golden.constraints.map(c => [c.name, c]));
  const tenantConMap = new Map(tenant.constraints.map(c => [c.name, c]));

  for (const [conName, gCon] of goldenConMap.entries()) {
    if (!tenantConMap.has(conName)) {
      missingConstraints.push({ table: gCon.table, constraint: conName, definition: gCon.definition });
    }
  }

  const reconciliationSql = isDrifted
    ? generateReconciliationSql(tenant.schema, missingColumns, missingIndexes, missingConstraints)
    : '';

  return {
    tenantId: tenant.tenantId,
    tenantName: tenant.tenantName,
    schema: tenant.schema,
    fingerprint: tenantFp,
    isGolden: !isDrifted && (tenant.tenantId === golden.tenantId),
    isDrifted,
    missingColumns,
    missingIndexes,
    missingConstraints,
    extraColumns,
    extraIndexes,
    reconciliationSql,
  };
}

/**
 * Evaluates schema drift across a fleet of tenant schemas.
 */
export function evaluateFleetDrift(
  tenantSchemas: NormalizedTenantSchema[],
  options: AuditDriftOptions = {}
): CrossTenantDriftReport {
  if (tenantSchemas.length === 0) {
    return {
      totalTenants: 0,
      driftedCount: 0,
      goldenTenant: '',
      goldenFingerprint: '',
      fingerprintGroups: {},
      profiles: [],
      checkedAt: new Date(),
    };
  }

  // 1. Calculate fingerprints and group tenants
  const fingerprints = new Map<string, string>(); // tenantId -> fingerprint
  const groups: Record<string, string[]> = {};

  for (const t of tenantSchemas) {
    const fp = calculateSchemaFingerprint(t);
    fingerprints.set(t.tenantId, fp);
    if (!groups[fp]) {
      groups[fp] = [];
    }
    groups[fp].push(t.tenantName);
  }

  // 2. Identify golden schema
  let goldenSchema: NormalizedTenantSchema | undefined;

  if (options.goldenTenant) {
    goldenSchema = tenantSchemas.find(
      t => t.tenantName === options.goldenTenant || t.schema === options.goldenTenant || t.tenantId === options.goldenTenant
    );
  }

  // Fallback to majority consensus
  if (!goldenSchema) {
    let maxCount = -1;
    let majorityFp = '';
    for (const [fp, members] of Object.entries(groups)) {
      if (members.length > maxCount) {
        maxCount = members.length;
        majorityFp = fp;
      }
    }
    goldenSchema = tenantSchemas.find(t => fingerprints.get(t.tenantId) === majorityFp) || tenantSchemas[0];
  }

  const goldenFingerprint = calculateSchemaFingerprint(goldenSchema);

  // 3. Compare each tenant against golden schema
  const profiles: TenantDriftProfile[] = tenantSchemas.map(t => {
    const prof = compareTenantToGolden(t, goldenSchema!);
    if (t.tenantId === goldenSchema!.tenantId) {
      prof.isGolden = true;
      prof.isDrifted = false;
    }
    return prof;
  });

  const driftedCount = profiles.filter(p => p.isDrifted).length;

  return {
    totalTenants: tenantSchemas.length,
    driftedCount,
    goldenTenant: goldenSchema.tenantName,
    goldenFingerprint,
    fingerprintGroups: groups,
    profiles,
    checkedAt: new Date(),
  };
}

/**
 * Introspects live database schemas for the provided tenant targets.
 */
export async function introspectTenantSchemas(
  client: PgClientLike,
  targets: TenantTarget[]
): Promise<NormalizedTenantSchema[]> {
  const result: NormalizedTenantSchema[] = [];
  const schemas = targets.map(t => t.schema || t.name);

  if (schemas.length === 0) return [];

  // Query Columns
  const colSql = `
    SELECT
      n.nspname AS schema_name,
      c.relname AS table_name,
      a.attname AS column_name,
      pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
      a.attnotnull AS is_not_null,
      pg_catalog.pg_get_expr(ad.adbin, ad.adrelid) AS default_expr
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    LEFT JOIN pg_catalog.pg_attrdef ad ON ad.adrelid = c.oid AND ad.adnum = a.attnum
    WHERE c.relkind IN ('r', 'p')
      AND n.nspname = ANY($1::text[])
    ORDER BY n.nspname, c.relname, a.attname;
  `;
  const colRes = await client.query(colSql, [schemas]);

  // Query Indexes
  const idxSql = `
    SELECT
      n.nspname AS schema_name,
      c_tbl.relname AS table_name,
      c_idx.relname AS index_name,
      i.indisunique AS is_unique,
      am.amname AS access_method,
      pg_catalog.pg_get_indexdef(i.indexrelid) AS index_def
    FROM pg_catalog.pg_index i
    JOIN pg_catalog.pg_class c_idx ON c_idx.oid = i.indexrelid
    JOIN pg_catalog.pg_class c_tbl ON c_tbl.oid = i.indrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c_tbl.relnamespace
    JOIN pg_catalog.pg_am am ON am.oid = c_idx.relam
    WHERE n.nspname = ANY($1::text[])
      AND i.indisvalid = true
    ORDER BY n.nspname, c_idx.relname;
  `;
  const idxRes = await client.query(idxSql, [schemas]);

  // Query Constraints
  const conSql = `
    SELECT
      n.nspname AS schema_name,
      c_tbl.relname AS table_name,
      con.conname AS constraint_name,
      con.contype AS constraint_type,
      con.convalidated AS is_validated,
      pg_catalog.pg_get_constraintdef(con.oid) AS constraint_def
    FROM pg_catalog.pg_constraint con
    JOIN pg_catalog.pg_class c_tbl ON c_tbl.oid = con.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c_tbl.relnamespace
    WHERE n.nspname = ANY($1::text[])
    ORDER BY n.nspname, con.conname;
  `;
  const conRes = await client.query(conSql, [schemas]);

  for (const target of targets) {
    const schemaName = target.schema || target.name;
    const targetCols = (colRes.rows || []).filter(r => r.schema_name === schemaName);
    const targetIdxs = (idxRes.rows || []).filter(r => r.schema_name === schemaName);
    const targetCons = (conRes.rows || []).filter(r => r.schema_name === schemaName);

    // Group columns by table
    const tableMap = new Map<string, NormalizedColumn[]>();
    for (const c of targetCols) {
      if (!tableMap.has(c.table_name)) {
        tableMap.set(c.table_name, []);
      }
      tableMap.get(c.table_name)!.push({
        name: c.column_name,
        dataType: c.data_type,
        isNotNull: Boolean(c.is_not_null),
        defaultExpr: c.default_expr ?? null,
      });
    }

    const tables: NormalizedTable[] = Array.from(tableMap.entries()).map(([name, columns]) => ({
      name,
      columns,
    }));

    const indexes: NormalizedIndex[] = targetIdxs.map(i => ({
      name: i.index_name,
      table: i.table_name,
      isUnique: Boolean(i.is_unique),
      accessMethod: i.access_method,
      definition: i.index_def,
    }));

    const constraints: NormalizedConstraint[] = targetCons.map(c => ({
      name: c.constraint_name,
      table: c.table_name,
      type: c.constraint_type as any,
      definition: c.constraint_def,
      isValidated: Boolean(c.is_validated),
    }));

    result.push({
      tenantId: target.id,
      tenantName: target.name,
      schema: schemaName,
      tables,
      indexes,
      constraints,
    });
  }

  return result;
}

/**
 * Formats cross-tenant drift report into a colorized, structured terminal output.
 */
export function formatDriftReportTerminal(report: CrossTenantDriftReport): string {
  const lines: string[] = [];

  lines.push('');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('  ddlforge v1.8.0 — Cross-Tenant Schema Drift Audit Report');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push(`Checked At:          ${report.checkedAt.toISOString()}`);
  lines.push(`Total Tenants:       ${report.totalTenants}`);
  lines.push(`Golden Reference:    "${report.goldenTenant}" (${report.goldenFingerprint.slice(0, 12)}...)`);
  lines.push(`Drifted Tenants:     ${report.driftedCount === 0 ? '0 (Fleet 100% In Sync)' : `${report.driftedCount} DRIFTED`}`);
  lines.push(`Unique Fingerprints: ${Object.keys(report.fingerprintGroups).length}`);
  lines.push('');

  lines.push('FINGERPRINT DISTRIBUTION:');
  for (const [fp, members] of Object.entries(report.fingerprintGroups)) {
    const isGolden = fp === report.goldenFingerprint;
    const badge = isGolden ? '[GOLDEN]' : '[DRIFTED]';
    const tag = `${badge} ${fp.slice(0, 16)}... : ${members.length} tenant(s)`;
    lines.push(`  • ${tag} (${members.slice(0, 5).join(', ')}${members.length > 5 ? ', ...' : ''})`);
  }
  lines.push('');

  if (report.driftedCount === 0) {
    lines.push('  ✔ All tenants match the golden schema. No schema drift detected.');
    lines.push('');
    return lines.join('\n');
  }

  lines.push('DRIFTED TENANTS (SNOWFLAKES) & RECONCILIATION DETAILS:');
  lines.push('──────────────────────────────────────────────────────────────────────');

  for (const p of report.profiles) {
    if (!p.isDrifted) continue;

    lines.push(`┌── Snowflake Tenant: "${p.tenantName}" (Schema: ${p.schema}) ─────────────────────`);
    lines.push(`│   Fingerprint: ${p.fingerprint.slice(0, 16)}...`);

    if (p.missingColumns.length > 0) {
      lines.push(`│   Missing Columns (${p.missingColumns.length}):`);
      for (const col of p.missingColumns) {
        lines.push(`│     - ${col.table}.${col.column} (${col.type})`);
      }
    }

    if (p.missingIndexes.length > 0) {
      lines.push(`│   Missing Indexes (${p.missingIndexes.length}):`);
      for (const idx of p.missingIndexes) {
        lines.push(`│     - ${idx.table}.${idx.index}`);
      }
    }

    if (p.missingConstraints.length > 0) {
      lines.push(`│   Missing Constraints (${p.missingConstraints.length}):`);
      for (const con of p.missingConstraints) {
        lines.push(`│     - ${con.table}.${con.constraint}`);
      }
    }

    if (p.extraColumns.length > 0) {
      lines.push(`│   Extra Columns (${p.extraColumns.length}):`);
      for (const col of p.extraColumns) {
        lines.push(`│     + ${col.table}.${col.column}`);
      }
    }

    if (p.reconciliationSql) {
      lines.push(`│`);
      lines.push(`│   Zero-Downtime Reconciliation SQL:`);
      for (const sqlLine of p.reconciliationSql.split('\n')) {
        lines.push(`│     ${sqlLine}`);
      }
    }

    lines.push(`└─────────────────────────────────────────────────────────────────────`);
    lines.push('');
  }

  return lines.join('\n');
}

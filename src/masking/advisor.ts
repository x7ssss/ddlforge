/**
 * ddlforge - Security & Storage Advisory Reporter
 *
 * Emits enterprise-grade hardening checklists, storage recommendations (HOT updates,
 * fillfactor), telemetry shielding (pg_stat_statements.track_utility), and referential
 * integrity validation queries for zero-downtime PII masking workflows.
 */

export interface MaskingAdviceOptions {
  table: string;
  schema?: string;
  columns?: string[];
  foreignKeys?: Array<{
    column: string;
    foreignTable: string;
    foreignColumn: string;
  }>;
  recommendedFillfactor?: number; // default: 85
  saltGuc?: string; // default: 'app.masking_salt'
}

export interface AdvisoryItem {
  category: 'storage' | 'security' | 'integrity' | 'telemetry';
  title: string;
  severity: 'RECOMMENDED' | 'CRITICAL' | 'INFO';
  description: string;
  sqlRemediation?: string;
}

export interface MaskingAdviceReport {
  table: string;
  schema: string;
  items: AdvisoryItem[];
  generatedAt: string;
}

/**
 * Generates actionable storage tuning, logging hardening, and referential
 * integrity validation advisories for a masked table.
 */
export function generateMaskingAdvice(options: MaskingAdviceOptions): MaskingAdviceReport {
  const schema = options.schema || 'public';
  const table = options.table.replace(/["`]/g, '');
  const fillfactor = options.recommendedFillfactor ?? 85;
  const saltGuc = options.saltGuc || 'app.masking_salt';
  const columns = options.columns || [];
  const foreignKeys = options.foreignKeys || [];

  const items: AdvisoryItem[] = [];

  // 1. Storage & HOT Optimization
  items.push({
    category: 'storage',
    title: 'Heap-Only Tuple (HOT) Optimization via Fillfactor',
    severity: 'RECOMMENDED',
    description: `Tuning fillfactor to ${fillfactor} reserves 15% free space on each heap page. During in-flight trigger execution and keyset backfills, shadow column updates stay on the same data page, avoiding new index tuple inserts and suppressing WAL write amplification.`,
    sqlRemediation: `ALTER TABLE "${schema}"."${table}" SET (fillfactor = ${fillfactor});
-- Optional: Rebuild table offline or during low-traffic maintenance to repack pages:
-- VACUUM FULL "${schema}"."${table}"; -- or use pg_repack "${table}"`,
  });

  // 2. Telemetry Shielding & Logging Hardening
  items.push({
    category: 'telemetry',
    title: 'pg_stat_statements Track Utility Disablement',
    severity: 'CRITICAL',
    description: `When using dynamic session GUCs (e.g. SET LOCAL ${saltGuc} = '...'), utility queries can be recorded in pg_stat_statements or server query logs. Disabling track_utility shields cryptographic salts from catalog leaks.`,
    sqlRemediation: `-- Run in postgresql.conf or as superuser:
ALTER SYSTEM SET pg_stat_statements.track_utility = off;
SELECT pg_reload_conf();

-- In your migration / ETL transaction:
SET LOCAL ${saltGuc} = '<ENTER_SECURE_RANDOM_SALT>';`,
  });

  // 3. Function Security Isolation
  items.push({
    category: 'security',
    title: 'Strict Function Search Path Hardening',
    severity: 'CRITICAL',
    description: `Masking functions must declare SECURITY DEFINER with SET search_path = pg_catalog, pg_temp to prevent untrusted schema injection attacks and operator resolution exploits.`,
    sqlRemediation: `ALTER FUNCTION "${schema}"."tf_mask_${table}"() SET search_path = pg_catalog, pg_temp;`,
  });

  // 4. Referential Integrity Post-Backfill Validation
  if (foreignKeys.length > 0) {
    for (const fk of foreignKeys) {
      const parentTable = fk.foreignTable;
      const parentCol = fk.foreignColumn;
      const childCol = fk.column;

      items.push({
        category: 'integrity',
        title: `Referential Integrity Audit: ${table}.${childCol} -> ${parentTable}.${parentCol}`,
        severity: 'RECOMMENDED',
        description: `Verify that deterministic masking on foreign key "${childCol}" produced no orphaned references against "${parentTable}.${parentCol}".`,
        sqlRemediation: `SELECT c."${childCol}_masked" AS orphaned_key, COUNT(*) AS count
FROM "${schema}"."${table}" c
LEFT JOIN "${schema}"."${parentTable}" p
  ON c."${childCol}_masked" = p."${parentCol}_masked"
WHERE c."${childCol}_masked" IS NOT NULL
  AND p."${parentCol}_masked" IS NULL
GROUP BY c."${childCol}_masked";`,
      });
    }
  } else {
    items.push({
      category: 'integrity',
      title: 'Cyclic Constraint Deferral During Backfill',
      severity: 'INFO',
      description: `If ${table} participates in cyclic foreign keys with other masked tables, enforce SET CONSTRAINTS ALL DEFERRED inside the backfill transaction to avoid premature foreign key violation errors.`,
      sqlRemediation: `BEGIN;
SET CONSTRAINTS ALL DEFERRED;
CALL "${schema}"."sp_mask_backfill_${table}"();
COMMIT;`,
    });
  }

  // 5. Autovacuum Tuning for High-Volume Backfills
  items.push({
    category: 'storage',
    title: 'Aggressive Autovacuum Scale Factor for Masking Backfills',
    severity: 'INFO',
    description: `During massive backfill sweeps, dead tuples accumulate rapidly. Lowering the autovacuum scale factor ensures dead tuple cleanup runs continuously without triggering lock stalls.`,
    sqlRemediation: `ALTER TABLE "${schema}"."${table}" SET (
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_vacuum_cost_limit = 1000
);`,
  });

  return {
    table,
    schema,
    items,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Formats the advisory report for colorized terminal output.
 */
export function formatMaskingAdviceTerminal(report: MaskingAdviceReport, useColor = true): string {
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
  lines.push(`${c.bold}${c.cyan}=== ddlforge Zero-Downtime Masking & Storage Advisory ===${c.reset}`);
  lines.push(`${c.gray}Target: ${report.schema}.${report.table} | Generated: ${report.generatedAt}${c.reset}`);
  lines.push(c.gray + '─'.repeat(70) + c.reset);

  for (const item of report.items) {
    let badge = '';
    if (item.severity === 'CRITICAL') {
      badge = `${c.bgRed} CRITICAL ${c.reset}`;
    } else if (item.severity === 'RECOMMENDED') {
      badge = `${c.bgYellow} RECOMMENDED ${c.reset}`;
    } else {
      badge = `${c.cyan}[INFO]${c.reset}`;
    }

    lines.push(`${badge} ${c.bold}${item.title}${c.reset}`);
    lines.push(`   ${item.description}`);
    if (item.sqlRemediation) {
      lines.push(`   ${c.green}${c.bold}SQL Remediation / Verification:${c.reset}`);
      for (const sqlLine of item.sqlRemediation.split('\n')) {
        lines.push(`     ${c.dim}${sqlLine}${c.reset}`);
      }
    }
    lines.push('');
  }

  lines.push(c.gray + '━'.repeat(70) + c.reset);
  lines.push(`${c.green}${c.bold}✔ Checklist ready:${c.reset} ${report.items.length} operational advisories generated.`);
  return lines.join('\n');
}

/**
 * Formats the advisory report as JSON.
 */
export function formatMaskingAdviceJson(report: MaskingAdviceReport): string {
  return JSON.stringify(report, null, 2);
}

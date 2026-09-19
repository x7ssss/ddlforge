/**
 * ddlforge - Hypothetical Index Simulator (hypopg)
 *
 * Simulates index creation in-memory without taking table locks, allocating disk,
 * or generating WAL using PostgreSQL's `hypopg` extension.
 *
 * Protocol:
 * 1. Verifies `hypopg` extension availability.
 * 2. Runs `EXPLAIN (FORMAT JSON)` for baseline query plan & total cost.
 * 3. Injects hypothetical index via `hypopg_create_index(indexSql)`.
 * 4. Re-runs `EXPLAIN (FORMAT JSON)` to verify planner adoption & cost reduction.
 * 5. Queries estimated relation size via `hypopg_relation_size()`.
 * 6. Always executes `hypopg_reset()` in finally block to ensure 0 session leakage.
 */

import type { PgClientLike } from '../cluster/advisory.js';

export interface HypoSimulationOptions {
  query: string;
  createIndexSql: string;
}

export interface HypoSimulationReport {
  query: string;
  createIndexSql: string;
  isHypopgAvailable: boolean;
  virtualIndexName?: string;
  virtualIndexOid?: number;
  virtualSizeBytes?: number;
  baselineCost: number;
  hypoCost: number;
  costDeltaPercent: number; // Positive = improvement (reduction in cost)
  isIndexSelected: boolean;
  baselinePlanType?: string;
  hypoPlanType?: string;
  recommendation: 'STRONG_RECOMMENDATION' | 'MARGINAL_IMPROVEMENT' | 'REJECTED_BY_PLANNER';
  explanation: string;
  checkedAt: Date;
}

/**
 * Parses EXPLAIN (FORMAT JSON) plan object to extract total cost and plan node details.
 */
export function parseExplainPlan(planOutput: unknown): {
  totalCost: number;
  startupCost: number;
  planType: string;
  rawPlan: any;
} {
  let root: any = planOutput;

  // Handle string JSON output if passed as raw text
  if (typeof planOutput === 'string') {
    try {
      root = JSON.parse(planOutput);
    } catch {
      return { totalCost: 0, startupCost: 0, planType: 'Unknown', rawPlan: null };
    }
  }

  // PostgreSQL EXPLAIN (FORMAT JSON) returns array of 1 element: [ { Plan: { ... } } ]
  const planNode = Array.isArray(root) && root[0]?.Plan ? root[0].Plan : (root?.Plan ?? root);

  const totalCost = typeof planNode?.['Total Cost'] === 'number' ? planNode['Total Cost'] : 0;
  const startupCost = typeof planNode?.['Startup Cost'] === 'number' ? planNode['Startup Cost'] : 0;
  const planType = typeof planNode?.['Node Type'] === 'string' ? planNode['Node Type'] : 'Unknown';

  return {
    totalCost,
    startupCost,
    planType,
    rawPlan: planNode,
  };
}

/**
 * Recursively searches query execution plan tree to determine if the hypothetical index was selected.
 */
export function isIndexUsedInPlan(planNode: any, indexName: string): boolean {
  if (!planNode || typeof planNode !== 'object') return false;

  if (planNode['Index Name'] === indexName) {
    return true;
  }

  // Check plans in Plans array
  if (Array.isArray(planNode.Plans)) {
    for (const child of planNode.Plans) {
      if (isIndexUsedInPlan(child, indexName)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Calculates percentage improvement in query execution cost.
 * Positive value = query got faster (cost reduced).
 */
export function calculateCostDelta(baselineCost: number, hypoCost: number): number {
  if (baselineCost <= 0) return 0;
  const delta = ((baselineCost - hypoCost) / baselineCost) * 100;
  return Math.round(delta * 10) / 10;
}

/**
 * Runs a complete hypothetical index simulation session.
 */
export async function simulateHypotheticalIndex(
  client: PgClientLike,
  options: HypoSimulationOptions
): Promise<HypoSimulationReport> {
  const query = options.query.trim().replace(/;+$/, '');
  const indexSql = options.createIndexSql.trim().replace(/;+$/, '');
  const checkedAt = new Date();

  // 1. Verify hypopg extension
  let isHypopgAvailable = false;
  try {
    const extRes = await client.query(`SELECT 1 FROM pg_extension WHERE extname = 'hypopg';`);
    if (extRes.rows && extRes.rows.length > 0) {
      isHypopgAvailable = true;
    }
  } catch {
    isHypopgAvailable = false;
  }

  if (!isHypopgAvailable) {
    return {
      query,
      createIndexSql: indexSql,
      isHypopgAvailable: false,
      baselineCost: 0,
      hypoCost: 0,
      costDeltaPercent: 0,
      isIndexSelected: false,
      recommendation: 'REJECTED_BY_PLANNER',
      explanation:
        'The `hypopg` extension is not installed on this PostgreSQL instance. Run `CREATE EXTENSION IF NOT EXISTS hypopg;` as superuser/admin to enable zero-overhead index simulation.',
      checkedAt,
    };
  }

  try {
    // 2. Obtain baseline plan & cost
    const baselineExplain = await client.query(`EXPLAIN (FORMAT JSON) ${query}`);
    const baselinePlan = parseExplainPlan(baselineExplain.rows[0]?.['QUERY PLAN'] ?? baselineExplain.rows[0]);

    // 3. Create hypothetical index
    const createRes = await client.query(`SELECT indexrelid, indexname FROM hypopg_create_index($1);`, [indexSql]);
    const virtualIndexOid = createRes.rows[0]?.indexrelid;
    const virtualIndexName = createRes.rows[0]?.indexname;

    // 4. Estimate virtual index size
    let virtualSizeBytes = 0;
    if (virtualIndexOid) {
      try {
        const sizeRes = await client.query(`SELECT hypopg_relation_size($1)::bigint AS size;`, [virtualIndexOid]);
        virtualSizeBytes = parseInt(sizeRes.rows[0]?.size, 10) || 0;
      } catch {
        virtualSizeBytes = 0;
      }
    }

    // 5. Obtain plan with hypothetical index
    const hypoExplain = await client.query(`EXPLAIN (FORMAT JSON) ${query}`);
    const hypoPlan = parseExplainPlan(hypoExplain.rows[0]?.['QUERY PLAN'] ?? hypoExplain.rows[0]);

    const isIndexSelected = virtualIndexName ? isIndexUsedInPlan(hypoPlan.rawPlan, virtualIndexName) : false;
    const costDeltaPercent = calculateCostDelta(baselinePlan.totalCost, hypoPlan.totalCost);

    let recommendation: 'STRONG_RECOMMENDATION' | 'MARGINAL_IMPROVEMENT' | 'REJECTED_BY_PLANNER';
    let explanation: string;

    if (!isIndexSelected) {
      recommendation = 'REJECTED_BY_PLANNER';
      explanation =
        'The query planner rejected the proposed index and preferred existing paths (e.g. sequential scan or existing index). The index would incur write penalty with 0 read benefit.';
    } else if (costDeltaPercent >= 30) {
      recommendation = 'STRONG_RECOMMENDATION';
      explanation = `The query planner adopted the index, cutting query cost by ${costDeltaPercent}% (${baselinePlan.totalCost} -> ${hypoPlan.totalCost}). Highly recommended.`;
    } else if (costDeltaPercent > 0) {
      recommendation = 'MARGINAL_IMPROVEMENT';
      explanation = `The index was selected but only reduced query cost by ${costDeltaPercent}% (${baselinePlan.totalCost} -> ${hypoPlan.totalCost}). Evaluate write overhead before deployment.`;
    } else {
      recommendation = 'REJECTED_BY_PLANNER';
      explanation = 'Index adopted but did not yield meaningful cost reduction.';
    }

    return {
      query,
      createIndexSql: indexSql,
      isHypopgAvailable: true,
      virtualIndexName,
      virtualIndexOid,
      virtualSizeBytes,
      baselineCost: baselinePlan.totalCost,
      hypoCost: hypoPlan.totalCost,
      costDeltaPercent,
      isIndexSelected,
      baselinePlanType: baselinePlan.planType,
      hypoPlanType: hypoPlan.planType,
      recommendation,
      explanation,
      checkedAt,
    };
  } finally {
    // 6. Mandatory cleanup: purge all hypothetical objects
    try {
      await client.query('SELECT hypopg_reset();');
    } catch {
      // Ignore cleanup error if connection closed
    }
  }
}

/**
 * Formats hypothetical simulation report into a colorized terminal presentation.
 */
export function formatSimulationReportTerminal(report: HypoSimulationReport): string {
  const lines: string[] = [];

  lines.push('');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('  ddlforge v1.9.0 — Hypothetical Index Simulation (hypopg)');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push(`Checked At:          ${report.checkedAt.toISOString()}`);
  lines.push(`hypopg Status:       ${report.isHypopgAvailable ? 'AVAILABLE' : 'UNAVAILABLE'}`);
  lines.push('');

  if (!report.isHypopgAvailable) {
    lines.push(`  ⚠ ${report.explanation}`);
    lines.push('');
    return lines.join('\n');
  }

  const badge = `[${report.recommendation}]`;
  const sizeMb = ((report.virtualSizeBytes || 0) / (1024 * 1024)).toFixed(2);

  lines.push(`┌── Proposed Index Simulation ────────────────────────────────────────`);
  lines.push(`│   Index DDL:       ${report.createIndexSql}`);
  lines.push(`│   Virtual Name:    ${report.virtualIndexName || 'N/A'}`);
  lines.push(`│   Estimated Size:  ${sizeMb} MB (0 bytes disk allocated during test)`);
  lines.push(`│   Planner Adopted: ${report.isIndexSelected ? 'YES (Index Scan Chosen)' : 'NO (Planner Ignored Index)'}`);
  lines.push(`│   Cost Delta:      ${report.costDeltaPercent >= 0 ? `-${report.costDeltaPercent}%` : `+${Math.abs(report.costDeltaPercent)}%`} (${report.baselineCost} -> ${report.hypoCost})`);
  lines.push(`│   Plan Transition: ${report.baselinePlanType} -> ${report.hypoPlanType}`);
  lines.push(`│   Recommendation:  ${badge}`);
  lines.push(`│   Explanation:     ${report.explanation}`);
  lines.push(`└─────────────────────────────────────────────────────────────────────`);
  lines.push('');

  return lines.join('\n');
}

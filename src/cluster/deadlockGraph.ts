/**
 * ddlforge - Live Contention & Deadlock Graph Engine
 *
 * Traverses `pg_blocking_pids()` and `pg_locks` to construct a directed graph of
 * lock waiters and blockers. Performs cycle detection to identify true deadlocks
 * (SQLSTATE 40P01) vs linear lock chains and computes root blocker PIDs for targeted remediation.
 */

import type { PgClientLike } from './advisory.js';

export interface LockNode {
  pid: number;
  query: string;
  state: string;
  lockMode: string;
  granted: boolean;
  table?: string;
  durationMs?: number;
  applicationName?: string;
}

export interface LockEdge {
  waiterPid: number;
  blockerPid: number;
  waitEvent?: string;
  lockType?: string;
}

export type DeadlockClassification = 'DEADLOCK_CYCLE' | 'LINEAR_LOCK_CHAIN' | 'CLEAN';

export interface DeadlockGraph {
  nodes: Map<number, LockNode>;
  edges: LockEdge[];
  cycles: number[][];
  classification: DeadlockClassification;
  rootBlockers: number[];
  timestamp: string;
}

/**
 * Detects directed cycles in wait-for graphs using depth-first search.
 * Edge u -> v represents: "PID u is WAITING ON PID v".
 */
export function detectGraphCycles(edges: LockEdge[]): number[][] {
  const adj = new Map<number, number[]>();
  const allNodes = new Set<number>();

  for (const edge of edges) {
    allNodes.add(edge.waiterPid);
    allNodes.add(edge.blockerPid);
    let neighbors = adj.get(edge.waiterPid);
    if (!neighbors) {
      neighbors = [];
      adj.set(edge.waiterPid, neighbors);
    }
    if (!neighbors.includes(edge.blockerPid)) {
      neighbors.push(edge.blockerPid);
    }
  }

  const visited = new Set<number>();
  const recStack = new Set<number>();
  const currentPath: number[] = [];
  const cycles: number[][] = [];

  function dfs(node: number): void {
    visited.add(node);
    recStack.add(node);
    currentPath.push(node);

    const neighbors = adj.get(node) || [];
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        dfs(neighbor);
      } else if (recStack.has(neighbor)) {
        const cycleStartIdx = currentPath.indexOf(neighbor);
        if (cycleStartIdx !== -1) {
          const cycle = currentPath.slice(cycleStartIdx);
          cycle.push(neighbor); // close loop: [A, B, A]
          cycles.push(cycle);
        }
      }
    }

    currentPath.pop();
    recStack.delete(node);
  }

  for (const node of allNodes) {
    if (!visited.has(node)) {
      dfs(node);
    }
  }

  return cycles;
}

/**
 * Identifies root blocker PIDs in a directed wait-for graph:
 * PIDs that block others (appear as blockerPid) but are NOT themselves waiting on anyone.
 */
export function findRootBlockers(edges: LockEdge[]): number[] {
  const waiterPids = new Set<number>();
  const blockerPids = new Set<number>();

  for (const edge of edges) {
    waiterPids.add(edge.waiterPid);
    blockerPids.add(edge.blockerPid);
  }

  const rootBlockers: number[] = [];
  for (const blocker of blockerPids) {
    if (!waiterPids.has(blocker) && !rootBlockers.includes(blocker)) {
      rootBlockers.push(blocker);
    }
  }

  return rootBlockers.sort((a, b) => a - b);
}

/**
 * Builds a DeadlockGraph from programmatic nodes and edges.
 */
export function buildDeadlockGraph(
  nodes: LockNode[],
  edges: LockEdge[]
): DeadlockGraph {
  const nodeMap = new Map<number, LockNode>();
  for (const node of nodes) {
    nodeMap.set(node.pid, node);
  }

  const cycles = detectGraphCycles(edges);
  const rootBlockers = findRootBlockers(edges);

  let classification: DeadlockClassification = 'CLEAN';
  if (cycles.length > 0) {
    classification = 'DEADLOCK_CYCLE';
  } else if (edges.length > 0) {
    classification = 'LINEAR_LOCK_CHAIN';
  }

  return {
    nodes: nodeMap,
    edges,
    cycles,
    classification,
    rootBlockers,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Queries PostgreSQL catalog and activity views to construct the live DeadlockGraph.
 */
export async function fetchLiveDeadlockGraph(client: PgClientLike): Promise<DeadlockGraph> {
  const query = `
    SELECT
      act.pid,
      act.query,
      act.state,
      act.application_name,
      act.wait_event_type,
      act.wait_event,
      COALESCE(EXTRACT(EPOCH FROM (clock_timestamp() - act.query_start)) * 1000, 0) AS duration_ms,
      pg_blocking_pids(act.pid) AS blocking_pids,
      COALESCE(l.mode, 'None') AS lock_mode,
      COALESCE(l.granted, false) AS granted,
      c.relname AS relation_name
    FROM pg_stat_activity act
    LEFT JOIN pg_locks l ON l.pid = act.pid
    LEFT JOIN pg_class c ON c.oid = l.relation
    WHERE act.pid != pg_backend_pid()
      AND (
        cardinality(pg_blocking_pids(act.pid)) > 0
        OR act.pid IN (SELECT unnest(pg_blocking_pids(pid)) FROM pg_stat_activity WHERE pid != pg_backend_pid())
      )
    ORDER BY act.pid;
  `;

  const res = await client.query(query).catch(() => ({ rows: [] }));

  const nodeMap = new Map<number, LockNode>();
  const edges: LockEdge[] = [];

  for (const row of res.rows) {
    const pid = Number(row['pid']);
    if (!nodeMap.has(pid)) {
      nodeMap.set(pid, {
        pid,
        query: String(row['query'] || ''),
        state: String(row['state'] || ''),
        lockMode: String(row['lock_mode'] || ''),
        granted: Boolean(row['granted']),
        table: row['relation_name'] ? String(row['relation_name']) : undefined,
        durationMs: Number(row['duration_ms'] || 0),
        applicationName: row['application_name'] ? String(row['application_name']) : undefined,
      });
    }

    const blockingPids: number[] = Array.isArray(row['blocking_pids'])
      ? row['blocking_pids'].map(Number)
      : [];

    for (const blockerPid of blockingPids) {
      if (blockerPid && blockerPid !== pid) {
        edges.push({
          waiterPid: pid,
          blockerPid,
          waitEvent: row['wait_event'] ? String(row['wait_event']) : undefined,
          lockType: row['wait_event_type'] ? String(row['wait_event_type']) : undefined,
        });

        // Ensure blocker node exists even if row didn't explicitly return it
        if (!nodeMap.has(blockerPid)) {
          nodeMap.set(blockerPid, {
            pid: blockerPid,
            query: '<active blocker backend>',
            state: 'active',
            lockMode: 'AccessExclusiveLock',
            granted: true,
          });
        }
      }
    }
  }

  const nodes = Array.from(nodeMap.values());
  return buildDeadlockGraph(nodes, edges);
}

/**
 * Formats the DeadlockGraph for colorized or plain ASCII terminal output.
 */
export function formatDeadlockGraphTerminal(graph: DeadlockGraph, useColor = true): string {
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
  lines.push(`${c.bold}${c.cyan}=== ddlforge Live Lock Contention & Deadlock Visualizer ===${c.reset}`);
  lines.push(`${c.gray}Snapshot: ${graph.timestamp} | Nodes: ${graph.nodes.size} | Edges: ${graph.edges.length}${c.reset}`);
  lines.push(c.gray + '─'.repeat(72) + c.reset);

  if (graph.classification === 'CLEAN') {
    lines.push(`${c.green}${c.bold}✔ ALL CLEAN:${c.reset} No lock contention, wait chains, or deadlocks detected.`);
    lines.push('');
    return lines.join('\n');
  }

  // 1. Deadlock cycle alert
  if (graph.classification === 'DEADLOCK_CYCLE') {
    lines.push(`${c.bgRed}${c.bold} 🚨 DEADLOCK CYCLE DETECTED (SQLSTATE 40P01) ${c.reset}`);
    for (const cycle of graph.cycles) {
      lines.push(`   ${c.red}${c.bold}Circular Wait: ${cycle.map(pid => `[PID ${pid}]`).join(' ──> ')}${c.reset}`);
    }
    lines.push('');
  }

  // 2. Directed edge visualizations
  lines.push(`${c.bold}Wait Chains (Waiter ──> Blocker):${c.reset}`);
  for (const edge of graph.edges) {
    const waiter = graph.nodes.get(edge.waiterPid);
    const blocker = graph.nodes.get(edge.blockerPid);

    const isRoot = graph.rootBlockers.includes(edge.blockerPid);
    const blockerLabel = isRoot ? `${c.yellow}[ROOT BLOCKER]${c.reset}` : '';

    const waiterDuration = waiter?.durationMs ? `(${Math.round(waiter.durationMs)}ms)` : '';
    lines.push(
      `   [PID ${edge.waiterPid}] ${c.dim}${waiter?.table || 'relation'}${c.reset} ${waiterDuration} ` +
      `──(${edge.waitEvent || 'Lock'})──> [PID ${edge.blockerPid}] ${blockerLabel}`
    );
  }
  lines.push('');

  // 3. Node details
  lines.push(`${c.bold}Backend Details:${c.reset}`);
  for (const [pid, node] of graph.nodes) {
    const isRoot = graph.rootBlockers.includes(pid);
    const badge = isRoot
      ? `${c.bgYellow} ROOT BLOCKER ${c.reset}`
      : (node.granted ? `${c.green}[HOLDER]${c.reset}` : `${c.yellow}[WAITING]${c.reset}`);

    const cleanQuery = (node.query || '<unknown>').replace(/\s+/g, ' ').slice(0, 80);
    lines.push(`   ${badge} ${c.bold}PID ${pid}${c.reset}: ${cleanQuery}`);
    if (node.table) {
      lines.push(`      Relation: ${node.table} | Mode: ${node.lockMode} | State: ${node.state}`);
    }
  }
  lines.push('');

  // 4. Remediation advice
  if (graph.rootBlockers.length > 0) {
    lines.push(c.gray + '━'.repeat(72) + c.reset);
    lines.push(`${c.bold}${c.cyan}Actionable Remediation:${c.reset}`);
    for (const rootPid of graph.rootBlockers) {
      lines.push(`   ${c.green}Terminate root blocker PID ${rootPid} to immediately release downstream queues:${c.reset}`);
      lines.push(`   ${c.dim}SELECT pg_cancel_backend(${rootPid}); -- or pg_terminate_backend(${rootPid});${c.reset}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * Formats the DeadlockGraph as JSON.
 */
export function formatDeadlockGraphJson(graph: DeadlockGraph): string {
  return JSON.stringify(
    {
      timestamp: graph.timestamp,
      classification: graph.classification,
      rootBlockers: graph.rootBlockers,
      cycles: graph.cycles,
      edges: graph.edges,
      nodes: Array.from(graph.nodes.values()),
    },
    null,
    2
  );
}

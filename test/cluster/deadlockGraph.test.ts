import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  detectGraphCycles,
  findRootBlockers,
  buildDeadlockGraph,
  formatDeadlockGraphTerminal,
  formatDeadlockGraphJson,
  LockEdge,
  LockNode,
} from '../../src/cluster/deadlockGraph.js';

describe('Deadlock Graph Engine & Cycle Detection', () => {
  describe('detectGraphCycles', () => {
    it('detects a 2-node reciprocal cycle (A -> B -> A)', () => {
      const edges: LockEdge[] = [
        { waiterPid: 101, blockerPid: 102, waitEvent: 'transactionid' },
        { waiterPid: 102, blockerPid: 101, waitEvent: 'relation' },
      ];

      const cycles = detectGraphCycles(edges);
      assert.strictEqual(cycles.length >= 1, true);
      const cycle = cycles[0];
      assert.strictEqual(cycle[0], cycle[cycle.length - 1], 'Cycle must close on the starting node');
      assert.ok(cycle.includes(101));
      assert.ok(cycle.includes(102));
    });

    it('detects a 3-node circular wait cycle (A -> B -> C -> A)', () => {
      const edges: LockEdge[] = [
        { waiterPid: 201, blockerPid: 202 },
        { waiterPid: 202, blockerPid: 203 },
        { waiterPid: 203, blockerPid: 201 },
      ];

      const cycles = detectGraphCycles(edges);
      assert.strictEqual(cycles.length >= 1, true);
      const cycle = cycles[0];
      assert.strictEqual(cycle[0], cycle[cycle.length - 1]);
      assert.ok(cycle.includes(201));
      assert.ok(cycle.includes(202));
      assert.ok(cycle.includes(203));
    });

    it('returns empty array for a linear lock chain with no cycles', () => {
      const edges: LockEdge[] = [
        { waiterPid: 301, blockerPid: 302 },
        { waiterPid: 302, blockerPid: 303 },
      ];

      const cycles = detectGraphCycles(edges);
      assert.deepStrictEqual(cycles, []);
    });

    it('returns empty array when there are no edges', () => {
      const cycles = detectGraphCycles([]);
      assert.deepStrictEqual(cycles, []);
    });
  });

  describe('findRootBlockers', () => {
    it('finds root blocker in a linear chain (A -> B -> C: C is root blocker)', () => {
      const edges: LockEdge[] = [
        { waiterPid: 401, blockerPid: 402 },
        { waiterPid: 402, blockerPid: 403 },
      ];

      const rootBlockers = findRootBlockers(edges);
      assert.deepStrictEqual(rootBlockers, [403]);
    });

    it('finds single root blocker holding multiple waiters', () => {
      const edges: LockEdge[] = [
        { waiterPid: 501, blockerPid: 500 },
        { waiterPid: 502, blockerPid: 500 },
        { waiterPid: 503, blockerPid: 500 },
      ];

      const rootBlockers = findRootBlockers(edges);
      assert.deepStrictEqual(rootBlockers, [500]);
    });

    it('returns empty list for pure deadlock cycle where every node is waiting', () => {
      const edges: LockEdge[] = [
        { waiterPid: 601, blockerPid: 602 },
        { waiterPid: 602, blockerPid: 601 },
      ];

      const rootBlockers = findRootBlockers(edges);
      assert.deepStrictEqual(rootBlockers, []);
    });
  });

  describe('buildDeadlockGraph', () => {
    it('classifies a clean state when no edges exist', () => {
      const nodes: LockNode[] = [
        { pid: 10, query: 'SELECT 1;', state: 'idle', lockMode: 'none', granted: true },
      ];
      const graph = buildDeadlockGraph(nodes, []);

      assert.strictEqual(graph.classification, 'CLEAN');
      assert.strictEqual(graph.edges.length, 0);
      assert.strictEqual(graph.cycles.length, 0);
      assert.strictEqual(graph.rootBlockers.length, 0);
    });

    it('classifies a linear lock chain without deadlocks', () => {
      const nodes: LockNode[] = [
        { pid: 1, query: 'ALTER TABLE t ADD COLUMN c int;', state: 'active', lockMode: 'AccessExclusiveLock', granted: false },
        { pid: 2, query: 'SELECT * FROM t;', state: 'active', lockMode: 'AccessShareLock', granted: true },
      ];
      const edges: LockEdge[] = [
        { waiterPid: 1, blockerPid: 2, waitEvent: 'relation' },
      ];

      const graph = buildDeadlockGraph(nodes, edges);
      assert.strictEqual(graph.classification, 'LINEAR_LOCK_CHAIN');
      assert.deepStrictEqual(graph.rootBlockers, [2]);
      assert.strictEqual(graph.cycles.length, 0);
    });

    it('classifies a true circular deadlock', () => {
      const nodes: LockNode[] = [
        { pid: 1, query: 'UPDATE accounts SET bal=bal-10 WHERE id=1;', state: 'active', lockMode: 'ExclusiveLock', granted: false },
        { pid: 2, query: 'UPDATE accounts SET bal=bal+10 WHERE id=2;', state: 'active', lockMode: 'ExclusiveLock', granted: false },
      ];
      const edges: LockEdge[] = [
        { waiterPid: 1, blockerPid: 2 },
        { waiterPid: 2, blockerPid: 1 },
      ];

      const graph = buildDeadlockGraph(nodes, edges);
      assert.strictEqual(graph.classification, 'DEADLOCK_CYCLE');
      assert.ok(graph.cycles.length > 0);
    });
  });

  describe('Formatters', () => {
    it('formats clean graph for terminal', () => {
      const graph = buildDeadlockGraph([], []);
      const output = formatDeadlockGraphTerminal(graph, false);
      assert.ok(output.includes('ALL CLEAN'));
      assert.ok(output.includes('No lock contention'));
    });

    it('formats deadlock cycle for terminal with remediation info', () => {
      const nodes: LockNode[] = [
        { pid: 10, query: 'UPDATE t SET x=1;', state: 'active', lockMode: 'RowExclusiveLock', granted: false, table: 't' },
        { pid: 20, query: 'UPDATE t SET y=2;', state: 'active', lockMode: 'RowExclusiveLock', granted: false, table: 't' },
      ];
      const edges: LockEdge[] = [
        { waiterPid: 10, blockerPid: 20 },
        { waiterPid: 20, blockerPid: 10 },
      ];

      const graph = buildDeadlockGraph(nodes, edges);
      const output = formatDeadlockGraphTerminal(graph, false);

      assert.ok(output.includes('DEADLOCK CYCLE DETECTED'));
      assert.ok(output.includes('Circular Wait: [PID 10] ──> [PID 20] ──> [PID 10]'));
    });

    it('formats linear lock chain with root blocker remediation advice', () => {
      const nodes: LockNode[] = [
        { pid: 11, query: 'ALTER TABLE orders ADD COLUMN status text;', state: 'active', lockMode: 'AccessExclusiveLock', granted: false, table: 'orders' },
        { pid: 22, query: 'SELECT * FROM orders WHERE id = 1;', state: 'active', lockMode: 'AccessShareLock', granted: true, table: 'orders' },
      ];
      const edges: LockEdge[] = [
        { waiterPid: 11, blockerPid: 22, waitEvent: 'relation' },
      ];

      const graph = buildDeadlockGraph(nodes, edges);
      const output = formatDeadlockGraphTerminal(graph, false);

      assert.ok(output.includes('ROOT BLOCKER'));
      assert.ok(output.includes('Actionable Remediation'));
      assert.ok(output.includes('SELECT pg_cancel_backend(22);'));
    });

    it('formats JSON representation with expected properties', () => {
      const nodes: LockNode[] = [
        { pid: 1, query: 'SELECT 1;', state: 'active', lockMode: 'ShareLock', granted: true },
      ];
      const graph = buildDeadlockGraph(nodes, []);
      const jsonStr = formatDeadlockGraphJson(graph);
      const parsed = JSON.parse(jsonStr);

      assert.strictEqual(parsed.classification, 'CLEAN');
      assert.ok(Array.isArray(parsed.nodes));
      assert.ok(Array.isArray(parsed.edges));
      assert.ok(Array.isArray(parsed.cycles));
      assert.ok(Array.isArray(parsed.rootBlockers));
      assert.ok(typeof parsed.timestamp === 'string');
    });
  });
});

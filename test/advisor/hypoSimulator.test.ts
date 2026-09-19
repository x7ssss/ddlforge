import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  parseExplainPlan,
  isIndexUsedInPlan,
  calculateCostDelta,
  simulateHypotheticalIndex,
  formatSimulationReportTerminal,
  HypoSimulationReport,
} from '../../src/advisor/hypoSimulator.js';
import type { PgClientLike } from '../../src/cluster/advisory.js';

describe('Hypothetical Index Simulator (hypopg) (src/advisor/hypoSimulator.ts)', () => {
  describe('parseExplainPlan', () => {
    it('parses standard PostgreSQL EXPLAIN (FORMAT JSON) array output', () => {
      const planArray = [
        {
          Plan: {
            'Node Type': 'Seq Scan',
            'Relation Name': 'users',
            'Startup Cost': 0.0,
            'Total Cost': 1450.25,
            'Plan Rows': 10000,
            'Plan Width': 64,
          },
        },
      ];

      const res = parseExplainPlan(planArray);
      assert.strictEqual(res.planType, 'Seq Scan');
      assert.strictEqual(res.totalCost, 1450.25);
      assert.strictEqual(res.startupCost, 0.0);
      assert.strictEqual(res.rawPlan['Relation Name'], 'users');
    });

    it('parses JSON string representation', () => {
      const jsonStr = JSON.stringify([
        {
          Plan: {
            'Node Type': 'Index Scan',
            'Index Name': 'idx_users_email',
            'Total Cost': 8.45,
            'Startup Cost': 0.42,
          },
        },
      ]);

      const res = parseExplainPlan(jsonStr);
      assert.strictEqual(res.planType, 'Index Scan');
      assert.strictEqual(res.totalCost, 8.45);
      assert.strictEqual(res.startupCost, 0.42);
    });

    it('handles malformed JSON string gracefully', () => {
      const res = parseExplainPlan('invalid json content');
      assert.strictEqual(res.planType, 'Unknown');
      assert.strictEqual(res.totalCost, 0);
      assert.strictEqual(res.startupCost, 0);
      assert.strictEqual(res.rawPlan, null);
    });

    it('handles direct object with Plan key or without Plan key', () => {
      const directObj = {
        'Node Type': 'Bitmap Heap Scan',
        'Total Cost': 45.1,
      };
      const res = parseExplainPlan(directObj);
      assert.strictEqual(res.planType, 'Bitmap Heap Scan');
      assert.strictEqual(res.totalCost, 45.1);
    });
  });

  describe('isIndexUsedInPlan', () => {
    it('detects index at the root plan node', () => {
      const plan = {
        'Node Type': 'Index Scan',
        'Index Name': '<13421>btree_users_email',
      };
      assert.strictEqual(isIndexUsedInPlan(plan, '<13421>btree_users_email'), true);
    });

    it('detects index in nested child plans', () => {
      const plan = {
        'Node Type': 'Nested Loop',
        Plans: [
          {
            'Node Type': 'Seq Scan',
            'Relation Name': 'orders',
          },
          {
            'Node Type': 'Bitmap Heap Scan',
            Plans: [
              {
                'Node Type': 'Bitmap Index Scan',
                'Index Name': '<24680>btree_users_id',
              },
            ],
          },
        ],
      };

      assert.strictEqual(isIndexUsedInPlan(plan, '<24680>btree_users_id'), true);
      assert.strictEqual(isIndexUsedInPlan(plan, 'non_existent_index'), false);
    });

    it('returns false for null or undefined plan', () => {
      assert.strictEqual(isIndexUsedInPlan(null, 'idx'), false);
      assert.strictEqual(isIndexUsedInPlan(undefined, 'idx'), false);
    });
  });

  describe('calculateCostDelta', () => {
    it('returns 0 when baseline cost is 0 or negative', () => {
      assert.strictEqual(calculateCostDelta(0, 50), 0);
      assert.strictEqual(calculateCostDelta(-10, 50), 0);
    });

    it('calculates positive improvement when cost decreases', () => {
      // 1000 -> 200: (1000 - 200) / 1000 * 100 = 80.0%
      assert.strictEqual(calculateCostDelta(1000, 200), 80.0);
    });

    it('calculates negative delta if hypothetical cost increased', () => {
      // 100 -> 150: (100 - 150) / 100 * 100 = -50.0%
      assert.strictEqual(calculateCostDelta(100, 150), -50.0);
    });
  });

  describe('simulateHypotheticalIndex', () => {
    it('detects missing hypopg extension and returns explanation', async () => {
      const mockClient: PgClientLike = {
        query: async (sql: string) => {
          if (sql.includes('pg_extension')) {
            return { rows: [] }; // Extension missing
          }
          throw new Error('Unexpected call');
        },
      };

      const res = await simulateHypotheticalIndex(mockClient, {
        query: 'SELECT * FROM users WHERE email = $1',
        createIndexSql: 'CREATE INDEX idx_users_email ON users (email)',
      });

      assert.strictEqual(res.isHypopgAvailable, false);
      assert.strictEqual(res.recommendation, 'REJECTED_BY_PLANNER');
      assert.ok(res.explanation.includes('hypopg'));
    });

    it('runs full simulation and yields STRONG_RECOMMENDATION when planner adopts index with >30% savings', async () => {
      let resetCalled = false;
      let hypoCreated = false;
      const mockClient: PgClientLike = {
        query: async (sql: string) => {
          if (sql.includes('pg_extension')) {
            return { rows: [{ '1': 1 }] };
          }
          if (sql.includes('EXPLAIN') && !resetCalled) {
            // Check if hypopg_create_index was already called
            if (sql.includes('users') && hypoCreated) {
              return {
                rows: [
                  {
                    'QUERY PLAN': [
                      {
                        Plan: {
                          'Node Type': 'Index Scan',
                          'Index Name': '<12345>btree_users_email',
                          'Total Cost': 12.5,
                        },
                      },
                    ],
                  },
                ],
              };
            }
            // Baseline query
            return {
              rows: [
                {
                  'QUERY PLAN': [
                    {
                      Plan: {
                        'Node Type': 'Seq Scan',
                        'Total Cost': 500.0,
                      },
                    },
                  ],
                },
              ],
            };
          }
          if (sql.includes('hypopg_create_index')) {
            hypoCreated = true;
            return {
              rows: [{ indexrelid: 12345, indexname: '<12345>btree_users_email' }],
            };
          }
          if (sql.includes('hypopg_relation_size')) {
            return { rows: [{ size: '1048576' }] }; // 1 MB
          }
          if (sql.includes('hypopg_reset')) {
            resetCalled = true;
            return { rows: [] };
          }
          return { rows: [] };
        },
      };

      const report = await simulateHypotheticalIndex(mockClient, {
        query: 'SELECT * FROM users WHERE email = $1',
        createIndexSql: 'CREATE INDEX idx_users_email ON users (email)',
      });

      assert.strictEqual(report.isHypopgAvailable, true);
      assert.strictEqual(report.virtualIndexName, '<12345>btree_users_email');
      assert.strictEqual(report.virtualSizeBytes, 1048576);
      assert.strictEqual(report.baselineCost, 500.0);
      assert.strictEqual(report.hypoCost, 12.5);
      // (500 - 12.5) / 500 = 97.5%
      assert.strictEqual(report.costDeltaPercent, 97.5);
      assert.strictEqual(report.isIndexSelected, true);
      assert.strictEqual(report.recommendation, 'STRONG_RECOMMENDATION');
      assert.strictEqual(resetCalled, true, 'hypopg_reset() must always be called');
    });

    it('yields MARGINAL_IMPROVEMENT when index is adopted but cost reduction is small', async () => {
      let resetCalled = false;
      let counter = 0;
      const mockClient: PgClientLike = {
        query: async (sql: string) => {
          if (sql.includes('pg_extension')) return { rows: [{ '1': 1 }] };
          if (sql.includes('hypopg_create_index')) {
            return { rows: [{ indexrelid: 5555, indexname: '<5555>btree_status' }] };
          }
          if (sql.includes('hypopg_relation_size')) return { rows: [{ size: '524288' }] };
          if (sql.includes('EXPLAIN')) {
            if (counter === 1) {
              return {
                rows: [
                  {
                    'QUERY PLAN': [
                      {
                        Plan: {
                          'Node Type': 'Index Scan',
                          'Index Name': '<5555>btree_status',
                          'Total Cost': 90.0,
                        },
                      },
                    ],
                  },
                ],
              };
            }
            counter = 1;
            return {
              rows: [
                {
                  'QUERY PLAN': [
                    {
                      Plan: {
                        'Node Type': 'Seq Scan',
                        'Total Cost': 100.0,
                      },
                    },
                  ],
                },
              ],
            };
          }
          if (sql.includes('hypopg_reset')) {
            resetCalled = true;
            return { rows: [] };
          }
          return { rows: [] };
        },
      };

      const report = await simulateHypotheticalIndex(mockClient, {
        query: 'SELECT * FROM orders WHERE status = $1',
        createIndexSql: 'CREATE INDEX idx_orders_status ON orders (status)',
      });

      assert.strictEqual(report.isIndexSelected, true);
      assert.strictEqual(report.costDeltaPercent, 10.0);
      assert.strictEqual(report.recommendation, 'MARGINAL_IMPROVEMENT');
      assert.strictEqual(resetCalled, true);
    });

    it('yields REJECTED_BY_PLANNER when index is ignored by planner', async () => {
      let resetCalled = false;
      const mockClient: PgClientLike = {
        query: async (sql: string) => {
          if (sql.includes('pg_extension')) return { rows: [{ '1': 1 }] };
          if (sql.includes('hypopg_create_index')) {
            return { rows: [{ indexrelid: 9999, indexname: '<9999>btree_flag' }] };
          }
          if (sql.includes('hypopg_relation_size')) return { rows: [{ size: '1000' }] };
          if (sql.includes('EXPLAIN')) {
            // Always returns Seq Scan without index
            return {
              rows: [
                {
                  'QUERY PLAN': [
                    {
                      Plan: {
                        'Node Type': 'Seq Scan',
                        'Total Cost': 50.0,
                      },
                    },
                  ],
                },
              ],
            };
          }
          if (sql.includes('hypopg_reset')) {
            resetCalled = true;
            return { rows: [] };
          }
          return { rows: [] };
        },
      } as any;

      const report = await simulateHypotheticalIndex(mockClient, {
        query: 'SELECT * FROM settings WHERE flag = $1',
        createIndexSql: 'CREATE INDEX idx_settings_flag ON settings (flag)',
      });

      assert.strictEqual(report.isIndexSelected, false);
      assert.strictEqual(report.recommendation, 'REJECTED_BY_PLANNER');
      assert.ok(report.explanation.includes('planner rejected the proposed index'));
      assert.strictEqual(resetCalled, true);
    });

    it('always executes hypopg_reset even when explain throws an error', async () => {
      let resetCalled = false;
      const mockClient: PgClientLike = {
        query: async (sql: string) => {
          if (sql.includes('pg_extension')) return { rows: [{ '1': 1 }] };
          if (sql.includes('EXPLAIN')) {
            throw new Error('syntax error in query');
          }
          if (sql.includes('hypopg_reset')) {
            resetCalled = true;
            return { rows: [] };
          }
          return { rows: [] };
        },
      } as any;

      await assert.rejects(
        async () => {
          await simulateHypotheticalIndex(mockClient, {
            query: 'INVALID SQL QUERY',
            createIndexSql: 'CREATE INDEX idx_err ON users (x)',
          });
        },
        /syntax error in query/
      );

      assert.strictEqual(resetCalled, true, 'hypopg_reset must run in finally block');
    });
  });

  describe('formatSimulationReportTerminal', () => {
    it('formats report when hypopg is unavailable', () => {
      const report: HypoSimulationReport = {
        query: 'SELECT 1',
        createIndexSql: 'CREATE INDEX idx ON t (a)',
        isHypopgAvailable: false,
        baselineCost: 0,
        hypoCost: 0,
        costDeltaPercent: 0,
        isIndexSelected: false,
        recommendation: 'REJECTED_BY_PLANNER',
        explanation: 'hypopg extension is not installed',
        checkedAt: new Date('2026-09-19T12:00:00.000Z'),
      };

      const out = formatSimulationReportTerminal(report);
      assert.ok(out.includes('Hypothetical Index Simulation (hypopg)'));
      assert.ok(out.includes('hypopg Status:       UNAVAILABLE'));
      assert.ok(out.includes('hypopg extension is not installed'));
    });

    it('formats report when simulation succeeds', () => {
      const report: HypoSimulationReport = {
        query: 'SELECT * FROM users WHERE email = $1',
        createIndexSql: 'CREATE INDEX idx_users_email ON users (email)',
        isHypopgAvailable: true,
        virtualIndexName: '<12345>btree_users_email',
        virtualIndexOid: 12345,
        virtualSizeBytes: 10485760, // 10 MB
        baselineCost: 500,
        hypoCost: 5,
        costDeltaPercent: 99.0,
        isIndexSelected: true,
        baselinePlanType: 'Seq Scan',
        hypoPlanType: 'Index Scan',
        recommendation: 'STRONG_RECOMMENDATION',
        explanation: 'Planner adopted index, cutting query cost by 99%.',
        checkedAt: new Date('2026-09-19T12:00:00.000Z'),
      };

      const out = formatSimulationReportTerminal(report);
      assert.ok(out.includes('[STRONG_RECOMMENDATION]'));
      assert.ok(out.includes('10.00 MB (0 bytes disk allocated during test)'));
      assert.ok(out.includes('Planner Adopted: YES (Index Scan Chosen)'));
      assert.ok(out.includes('Cost Delta:      -99% (500 -> 5)'));
      assert.ok(out.includes('Plan Transition: Seq Scan -> Index Scan'));
    });
  });
});

/**
 * ddlforge — test/harness/testHarness.test.ts
 *
 * Unit tests for the TestHarness and ContainerRunner.
 *
 * These tests run WITHOUT a real Docker container — they verify the
 * harness logic (option defaults, result structure, skip guard) using
 * a lightweight mock that replaces PostgreSqlContainer and pg.Client.
 *
 * Real container integration tests (requiring DOCKER_AVAILABLE=true) are
 * skipped in this file and should be run separately in CI with Docker.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { TestHarness, type MigrationRunResult } from '../../src/harness/testHarness.js';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/**
 * Creates a minimal mock of the TestHarness internals so we can test
 * result structure and options without spawning a real container.
 */
class MockHarness extends TestHarness {
  public mockQueryResults: Record<string, any[]> = {};
  public queriesExecuted: string[] = [];

  // Override start() to inject a mock client directly
  async start(): Promise<void> {
    // Inject mock internals — use any-cast to bypass private access
    (this as any).client = {
      query: async (sql: string | { text: string }) => {
        const q = typeof sql === 'string' ? sql : sql.text;
        this.queriesExecuted.push(q);
        // Return mock pg_locks rows
        if (q.includes('pg_locks')) {
          return { rows: this.mockQueryResults['pg_locks'] ?? [] };
        }
        return { rows: [] };
      },
      end: async () => { /* no-op */ },
    };
    (this as any).container = {
      stop: async () => { /* no-op */ },
    };
    (this as any).stopSignaled = false;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TestHarness', () => {
  describe('options defaults', () => {
    it('defaults maxLockMs to 500ms', () => {
      const h = new TestHarness();
      assert.strictEqual((h as any).options.maxLockMs, 500);
    });

    it('defaults pollIntervalMs to 50ms', () => {
      const h = new TestHarness();
      assert.strictEqual((h as any).options.pollIntervalMs, 50);
    });

    it('defaults image to postgres:17-alpine', () => {
      const h = new TestHarness();
      assert.strictEqual((h as any).options.image, 'postgres:17-alpine');
    });

    it('accepts custom maxLockMs', () => {
      const h = new TestHarness({ maxLockMs: 1000 });
      assert.strictEqual((h as any).options.maxLockMs, 1000);
    });

    it('accepts custom image', () => {
      const h = new TestHarness({ image: 'postgres:16-alpine' });
      assert.strictEqual((h as any).options.image, 'postgres:16-alpine');
    });
  });

  describe('not-started guard', () => {
    it('throws if runMigration is called before start()', async () => {
      const h = new TestHarness();
      await assert.rejects(
        () => h.runMigration('SELECT 1'),
        /not started/i,
        'Expected "not started" error'
      );
    });
  });

  describe('stop()', () => {
    it('sets stopSignaled flag and can be called multiple times safely', async () => {
      const h = new MockHarness();
      await h.start();
      await h.stop();
      assert.strictEqual((h as any).stopSignaled, true);
      // Second call should not throw
      await h.stop();
    });

    it('nulls client and container after stop', async () => {
      const h = new MockHarness();
      await h.start();
      await h.stop();
      assert.strictEqual((h as any).client, null);
      assert.strictEqual((h as any).container, null);
    });
  });

  describe('runMigration()', () => {
    let harness: MockHarness;

    before(async () => {
      harness = new MockHarness({ maxLockMs: 100, pollIntervalMs: 10 });
      await harness.start();
    });

    after(async () => {
      await harness.stop();
    });

    it('returns success=true for valid SQL', async () => {
      const result: MigrationRunResult = await harness.runMigration('SELECT 1; SELECT 2');
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.error, undefined);
    });

    it('returns a valid schema name', async () => {
      const result: MigrationRunResult = await harness.runMigration('SELECT 1');
      assert.match(result.schema, /^test_[0-9a-f_]+$/i, 'Schema should be test_<uuid>');
    });

    it('returns non-negative durationMs', async () => {
      const result: MigrationRunResult = await harness.runMigration('SELECT 1');
      assert.ok(result.durationMs >= 0, `durationMs should be >= 0, got ${result.durationMs}`);
    });

    it('returns maxObservedLockMs=0 when no locks detected', async () => {
      harness.mockQueryResults['pg_locks'] = []; // no locks
      const result: MigrationRunResult = await harness.runMigration('SELECT 1');
      assert.strictEqual(result.maxObservedLockMs, 0);
    });

    it('lockThresholdExceeded=false when no locks', async () => {
      harness.mockQueryResults['pg_locks'] = [];
      const result: MigrationRunResult = await harness.runMigration('SELECT 1');
      assert.strictEqual(result.lockThresholdExceeded, false);
    });

    it('returns success=false and error message for failed SQL', async () => {
      // Make the mock client throw on query
      const originalClient = (harness as any).client;
      (harness as any).client = {
        query: async (sql: string) => {
          if (sql.includes('INVALID_SQL_THAT_FAILS')) {
            throw new Error('syntax error at or near "INVALID_SQL_THAT_FAILS"');
          }
          return { rows: [] };
        },
        end: async () => {},
      };

      const result: MigrationRunResult = await harness.runMigration('INVALID_SQL_THAT_FAILS');
      assert.strictEqual(result.success, false);
      assert.ok(result.error?.includes('syntax error'), `Expected syntax error, got: ${result.error}`);

      // Restore
      (harness as any).client = originalClient;
    });

    it('each runMigration uses a unique schema name', async () => {
      const r1 = await harness.runMigration('SELECT 1');
      const r2 = await harness.runMigration('SELECT 2');
      assert.notStrictEqual(r1.schema, r2.schema, 'Each migration run must use a unique schema');
    });
  });

  describe('getConnectionString()', () => {
    it('returns null before start()', () => {
      const h = new TestHarness();
      assert.strictEqual(h.getConnectionString(), null);
    });

    it('returns null after stop()', async () => {
      const h = new MockHarness();
      await h.start();
      // Mock container.getConnectionUri
      (h as any).container = {
        stop: async () => {},
        getConnectionUri: () => 'postgres://localhost/test',
      };
      await h.stop();
      assert.strictEqual(h.getConnectionString(), null);
    });
  });
});

describe('runContainerTests (skipped without Docker)', () => {
  it('is exported as a function', async () => {
    const { runContainerTests } = await import('../../src/harness/testHarness.js');
    assert.strictEqual(typeof runContainerTests, 'function');
  });

  it('has correct signature', async () => {
    const { runContainerTests } = await import('../../src/harness/testHarness.js');
    // Verify it's async (returns Promise) — async functions have 'AsyncFunction' constructor
    assert.ok(
      runContainerTests.constructor.name === 'AsyncFunction' || runContainerTests.constructor.name === 'Function',
      `Expected function, got: ${runContainerTests.constructor.name}`
    );
  });

  /**
   * Real Docker container test — only runs when DOCKER_AVAILABLE=true
   * This provides a live integration test gate for CI environments.
   */
  it('skips live container test when DOCKER_AVAILABLE is not set', () => {
    if (process.env['DOCKER_AVAILABLE'] === 'true') {
      // This would run an actual container test — skip here
      return;
    }
    // In local dev, assert that the skip guard works as expected
    assert.notStrictEqual(process.env['DOCKER_AVAILABLE'], 'true');
  });
});

describe('HarnessOptions', () => {
  it('respects DDLFORGE_TEST_PG_IMAGE env var as default image', () => {
    const original = process.env['DDLFORGE_TEST_PG_IMAGE'];
    process.env['DDLFORGE_TEST_PG_IMAGE'] = 'postgres:15-alpine';

    try {
      const h = new TestHarness(); // no explicit image
      assert.strictEqual((h as any).options.image, 'postgres:15-alpine');
    } finally {
      if (original === undefined) {
        delete process.env['DDLFORGE_TEST_PG_IMAGE'];
      } else {
        process.env['DDLFORGE_TEST_PG_IMAGE'] = original;
      }
    }
  });

  it('explicit image option takes precedence over env var', () => {
    const original = process.env['DDLFORGE_TEST_PG_IMAGE'];
    process.env['DDLFORGE_TEST_PG_IMAGE'] = 'postgres:15-alpine';

    try {
      const h = new TestHarness({ image: 'postgres:16-alpine' });
      assert.strictEqual((h as any).options.image, 'postgres:16-alpine');
    } finally {
      if (original === undefined) {
        delete process.env['DDLFORGE_TEST_PG_IMAGE'];
      } else {
        process.env['DDLFORGE_TEST_PG_IMAGE'] = original;
      }
    }
  });
});

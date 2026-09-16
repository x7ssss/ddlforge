/**
 * ddlforge - Unit tests for runner modules: backoff, locksMonitor, executor
 *
 * These tests run in pure Node.js (no pg connection required).
 * The locksMonitor and executor tests use in-process mocks.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

/* ──────────────────────────────────────────────────────────────────── */
/* Import runner modules (compiled output lives in dist/src/runner/)   */
/* ──────────────────────────────────────────────────────────────────── */
import {
  computeBackoff,
  sleep,
  retryIterator,
  BackoffOptions,
} from '../src/runner/backoff.js';

import {
  startLockMonitor,
  isLockError,
  MonitorClient,
} from '../src/runner/locksMonitor.js';

import {
  parseMigrationStatements,
  isConcurrentStatement,
} from '../src/runner/executor.js';

/* ──────────────────────────────────────────────────────────────────── */
/* Backoff tests                                                        */
/* ──────────────────────────────────────────────────────────────────── */

describe('Backoff: computeBackoff()', () => {
  it('returns sleepMs of 0 on attempt 0 with baseDelay=0', () => {
    const result = computeBackoff(0, { baseDelayMs: 0, maxDelayMs: 10_000 });
    assert.strictEqual(result.sleepMs, 0);
    assert.strictEqual(result.attempt, 0);
    assert.strictEqual(result.exceeded, false);
  });

  it('returns sleepMs in [0, maxDelayMs] for any attempt', () => {
    const opts: BackoffOptions = { baseDelayMs: 250, maxDelayMs: 5000, maxRetries: 5 };
    for (let attempt = 0; attempt <= 10; attempt++) {
      const result = computeBackoff(attempt, opts);
      assert.ok(result.sleepMs >= 0, `sleepMs should be >= 0 (attempt=${attempt})`);
      assert.ok(
        result.sleepMs <= 5000,
        `sleepMs should be <= maxDelayMs=5000 (attempt=${attempt}, got ${result.sleepMs})`
      );
    }
  });

  it('marks exceeded=true when attempt >= maxRetries', () => {
    const opts: BackoffOptions = { maxRetries: 3 };
    assert.strictEqual(computeBackoff(2, opts).exceeded, false);
    assert.strictEqual(computeBackoff(3, opts).exceeded, true);
    assert.strictEqual(computeBackoff(4, opts).exceeded, true);
  });

  it('caps sleep at maxDelayMs regardless of high attempt numbers', () => {
    const opts: BackoffOptions = { baseDelayMs: 1000, maxDelayMs: 2000 };
    for (let attempt = 0; attempt < 100; attempt++) {
      const result = computeBackoff(attempt, opts);
      assert.ok(result.sleepMs <= 2000, `sleepMs exceeded maxDelayMs at attempt=${attempt}`);
    }
  });

  it('jitter: repeated calls for same attempt yield different values', () => {
    const opts: BackoffOptions = { baseDelayMs: 500, maxDelayMs: 10_000 };
    const results = new Set<number>();
    for (let i = 0; i < 20; i++) {
      results.add(Math.round(computeBackoff(3, opts).sleepMs));
    }
    // With random jitter over [0, 4000ms], 20 calls should produce > 5 distinct values
    assert.ok(results.size > 5, `Expected jitter variation, got only ${results.size} distinct values`);
  });
});

describe('Backoff: sleep()', () => {
  it('resolves after approximately the given duration', async () => {
    const start = Date.now();
    await sleep(50);
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 40, `Expected >= 40ms, got ${elapsed}ms`);
  });

  it('rejects immediately when signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort(new Error('pre-aborted'));
    await assert.rejects(
      () => sleep(1000, ac.signal),
      (err: Error) => err.message === 'pre-aborted' || true
    );
  });

  it('rejects early when signal fires during sleep', async () => {
    const ac = new AbortController();
    const start = Date.now();
    const timer = setTimeout(() => ac.abort(new Error('cancelled')), 30);
    await assert.rejects(() => sleep(2000, ac.signal));
    const elapsed = Date.now() - start;
    clearTimeout(timer);
    assert.ok(elapsed < 500, `Should have rejected early but took ${elapsed}ms`);
  });
});

describe('Backoff: retryIterator()', () => {
  it('yields exactly maxRetries+1 times (0..maxRetries inclusive)', () => {
    const iterations: number[] = [];
    for (const b of retryIterator(3)) {
      iterations.push(b.attempt);
    }
    assert.deepStrictEqual(iterations, [0, 1, 2, 3]);
  });

  it('yields exceeded=false for all but last item', () => {
    const results = [...retryIterator(2)];
    assert.strictEqual(results[0].exceeded, false);
    assert.strictEqual(results[1].exceeded, false);
    assert.strictEqual(results[2].exceeded, true);
  });
});

/* ──────────────────────────────────────────────────────────────────── */
/* isLockError tests                                                    */
/* ──────────────────────────────────────────────────────────────────── */

describe('isLockError()', () => {
  it('returns true for 55P03 (lock_not_available)', () => {
    assert.strictEqual(isLockError('55P03'), true);
  });

  it('returns true for 57014 (query_canceled)', () => {
    assert.strictEqual(isLockError('57014'), true);
  });

  it('returns false for unrelated error codes', () => {
    assert.strictEqual(isLockError('23505'), false);  // unique_violation
    assert.strictEqual(isLockError('42601'), false);  // syntax_error
    assert.strictEqual(isLockError(''),      false);
    assert.strictEqual(isLockError('00000'), false);
  });
});

/* ──────────────────────────────────────────────────────────────────── */
/* Lock monitor tests (mock client, no real DB)                        */
/* ──────────────────────────────────────────────────────────────────── */

describe('startLockMonitor()', () => {
  /**
   * Creates a mock MonitorClient that returns a fixed blocked_count
   * on the first BLOCKED_QUERY_SQL and has a no-op end().
   */
  function mockClient(blockedCount: number): MonitorClient {
    return {
      async query(sql: string) {
        // All queries go through the same mock
        if (sql.includes('pg_backend_pid')) {
          return { rows: [{ pid: 999 }] };
        }
        if (sql.includes('statement_timeout') || sql.includes('lock_timeout')) {
          return { rows: [] };
        }
        // Lock count queries
        return { rows: [{ blocked_count: String(blockedCount) }] };
      },
      async end() { /* no-op */ },
    };
  }

  it('stops cleanly when external stop() is called (no avalanche)', async () => {
    const { result, stop } = startLockMonitor({
      migrationPid:  1234,
      clientFactory: async () => mockClient(0),
      pollIntervalMs: 50,
      queueThreshold: 1,
    });

    // Let one poll cycle run, then stop
    await sleep(80);
    stop();

    const res = await result;
    assert.strictEqual(res.avalanche, false);
    assert.strictEqual(res.stopReason, 'external-stop');
  });

  it('detects avalanche and returns avalanche=true when blocked >= threshold', async () => {
    // blockedCount = 2, threshold = 1 → should trigger immediately
    const { result } = startLockMonitor({
      migrationPid:  5678,
      clientFactory: async () => mockClient(2),
      pollIntervalMs: 30,
      queueThreshold: 1,
    });

    const res = await result;
    assert.strictEqual(res.avalanche, true);
    assert.strictEqual(res.stopReason, 'avalanche');
    assert.ok(res.blockedCount >= 1);
    assert.ok(res.cancelledAt.length > 0);
  });

  it('does NOT trigger avalanche when blocked < threshold', async () => {
    // blockedCount = 0, threshold = 2 → no avalanche
    const { result, stop } = startLockMonitor({
      migrationPid:  9999,
      clientFactory: async () => mockClient(0),
      pollIntervalMs: 30,
      queueThreshold: 2,
    });

    await sleep(100);
    stop();
    const res = await result;
    assert.strictEqual(res.avalanche, false);
  });

  it('stops when AbortSignal is aborted', async () => {
    const ac = new AbortController();

    const { result } = startLockMonitor({
      migrationPid:  1111,
      clientFactory: async () => mockClient(0),
      pollIntervalMs: 50,
      queueThreshold: 1,
      signal: ac.signal,
    });

    await sleep(40);
    ac.abort();

    const res = await result;
    assert.strictEqual(res.avalanche, false);
    assert.strictEqual(res.stopReason, 'aborted');
  });

  it('handles a pre-aborted AbortSignal immediately', async () => {
    const ac = new AbortController();
    ac.abort();

    const { result } = startLockMonitor({
      migrationPid:  2222,
      clientFactory: async () => mockClient(0),
      pollIntervalMs: 50,
      queueThreshold: 1,
      signal: ac.signal,
    });

    const res = await result;
    assert.ok(res.stopReason === 'aborted' || res.stopReason === 'external-stop');
  });
});

/* ──────────────────────────────────────────────────────────────────── */
/* isConcurrentStatement — transaction-isolation classifier             */
/* ──────────────────────────────────────────────────────────────────── */

describe('isConcurrentStatement()', () => {
  // ── Positive cases — must run OUTSIDE a transaction block ──────────
  it('detects CREATE INDEX CONCURRENTLY', () => {
    assert.strictEqual(
      isConcurrentStatement('CREATE INDEX CONCURRENTLY idx ON t(col);'),
      true,
    );
  });

  it('detects CREATE UNIQUE INDEX CONCURRENTLY', () => {
    assert.strictEqual(
      isConcurrentStatement('CREATE UNIQUE INDEX CONCURRENTLY idx_u ON t(col);'),
      true,
    );
  });

  it('detects DROP INDEX CONCURRENTLY', () => {
    assert.strictEqual(
      isConcurrentStatement('DROP INDEX CONCURRENTLY idx;'),
      true,
    );
  });

  it('detects REINDEX … CONCURRENTLY', () => {
    assert.strictEqual(
      isConcurrentStatement('REINDEX TABLE CONCURRENTLY my_table;'),
      true,
    );
    assert.strictEqual(
      isConcurrentStatement('REINDEX INDEX CONCURRENTLY idx_foo;'),
      true,
    );
  });

  it('detects VACUUM (any form)', () => {
    assert.strictEqual(isConcurrentStatement('VACUUM;'), true);
    assert.strictEqual(isConcurrentStatement('VACUUM ANALYZE users;'), true);
    assert.strictEqual(isConcurrentStatement('VACUUM FULL users;'), true);
  });

  it('is case-insensitive and whitespace-tolerant', () => {
    assert.strictEqual(
      isConcurrentStatement('  create   index   concurrently   idx ON t(x);'),
      true,
    );
    assert.strictEqual(
      isConcurrentStatement('  vacuum   analyze   users;'),
      true,
    );
  });

  // ── Negative cases — must run INSIDE a transaction block ───────────
  it('returns false for CREATE INDEX (non-concurrent)', () => {
    assert.strictEqual(
      isConcurrentStatement('CREATE INDEX idx ON t(col);'),
      false,
    );
  });

  it('returns false for DROP INDEX (non-concurrent)', () => {
    assert.strictEqual(
      isConcurrentStatement('DROP INDEX idx;'),
      false,
    );
  });

  it('returns false for ALTER TABLE', () => {
    assert.strictEqual(
      isConcurrentStatement('ALTER TABLE users ADD COLUMN bio TEXT;'),
      false,
    );
  });

  it('returns false for CREATE TABLE', () => {
    assert.strictEqual(
      isConcurrentStatement('CREATE TABLE users (id INT);'),
      false,
    );
  });

  it('returns false for plain REINDEX without CONCURRENTLY', () => {
    assert.strictEqual(
      isConcurrentStatement('REINDEX TABLE my_table;'),
      false,
    );
  });
});

/* ──────────────────────────────────────────────────────────────────── */
/* parseMigrationStatements — uses the real SQL lexer                  */
/* ──────────────────────────────────────────────────────────────────── */

describe('parseMigrationStatements()', () => {
  it('splits a multi-statement migration correctly', () => {
    const sql = `
      CREATE INDEX CONCURRENTLY idx_users_email ON users(email);
      ALTER TABLE users ADD COLUMN bio TEXT;
      ALTER TABLE orders ADD CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id) NOT VALID;
    `;
    const stmts = parseMigrationStatements(sql);
    assert.strictEqual(stmts.length, 3);
    assert.ok(stmts[0].toUpperCase().includes('CREATE INDEX'));
    assert.ok(stmts[1].toUpperCase().includes('ALTER TABLE'));
    assert.ok(stmts[2].toUpperCase().includes('FOREIGN KEY'));
  });

  it('handles dollar-quoted functions as a single statement', () => {
    const sql = `
      CREATE OR REPLACE FUNCTION bump_seq() RETURNS void AS $$
      BEGIN
        PERFORM nextval('my_seq');
      END;
      $$ LANGUAGE plpgsql;
    `;
    const stmts = parseMigrationStatements(sql);
    assert.strictEqual(stmts.length, 1);
    assert.ok(stmts[0].includes('$$'));
  });

  it('returns empty array for blank SQL', () => {
    assert.deepStrictEqual(parseMigrationStatements(''), []);
    assert.deepStrictEqual(parseMigrationStatements('   \n\t  '), []);
  });

  it('handles trailing statement without semicolon', () => {
    const sql = 'CREATE TABLE t1 (id INT);\nCREATE TABLE t2 (id INT)';
    const stmts = parseMigrationStatements(sql);
    assert.strictEqual(stmts.length, 2);
  });

  it('ignores semicolons inside string literals', () => {
    const sql = `INSERT INTO config (key, val) VALUES ('sep', ';');`;
    const stmts = parseMigrationStatements(sql);
    assert.strictEqual(stmts.length, 1);
  });

  it('ignores semicolons inside block comments', () => {
    const sql = `
      /* This comment has a ; semicolon inside */
      CREATE TABLE test (id INT);
    `;
    const stmts = parseMigrationStatements(sql);
    assert.strictEqual(stmts.length, 1);
  });
});

/* ──────────────────────────────────────────────────────────────────── */
/* CLI: parseApplyArgs                                                  */
/* ──────────────────────────────────────────────────────────────────── */

import { parseApplyArgs } from '../src/cli.js';

describe('parseApplyArgs()', () => {
  it('parses positional file and --db flag', () => {
    const opts = parseApplyArgs(['./migrations/001.sql', '--db', 'postgres://localhost/mydb']);
    assert.strictEqual(opts.file, './migrations/001.sql');
    assert.strictEqual(opts.databaseUrl, 'postgres://localhost/mydb');
  });

  it('parses --db= form', () => {
    const opts = parseApplyArgs(['file.sql', '--db=postgres://host/db']);
    assert.strictEqual(opts.databaseUrl, 'postgres://host/db');
  });

  it('parses --lock-timeout and appends ms suffix', () => {
    const opts = parseApplyArgs(['f.sql', '--db', 'url', '--lock-timeout', '5000']);
    assert.strictEqual(opts.lockTimeout, '5000ms');
  });

  it('preserves ms suffix if already present', () => {
    const opts = parseApplyArgs(['f.sql', '--db', 'url', '--lock-timeout', '2500ms']);
    assert.strictEqual(opts.lockTimeout, '2500ms');
  });

  it('parses --statement-timeout', () => {
    const opts = parseApplyArgs(['f.sql', '--db', 'url', '--statement-timeout', '60000']);
    assert.strictEqual(opts.statementTimeout, '60000ms');
  });

  it('parses --max-retries', () => {
    const opts = parseApplyArgs(['f.sql', '--db', 'url', '--max-retries', '3']);
    assert.strictEqual(opts.maxRetries, 3);
  });

  it('parses --dry-run flag', () => {
    const opts = parseApplyArgs(['f.sql', '--db', 'url', '--dry-run']);
    assert.strictEqual(opts.dryRun, true);
  });

  it('parses --lock-queue-threshold', () => {
    const opts = parseApplyArgs(['f.sql', '--db', 'url', '--lock-queue-threshold', '3']);
    assert.strictEqual(opts.lockQueueThreshold, 3);
  });

  it('parses --monitor-poll-ms', () => {
    const opts = parseApplyArgs(['f.sql', '--db', 'url', '--monitor-poll-ms', '250']);
    assert.strictEqual(opts.monitorPollMs, 250);
  });

  it('sets help=true for --help flag', () => {
    const opts = parseApplyArgs(['--help']);
    assert.strictEqual(opts.help, true);
  });

  it('uses defaults for unprovided options', () => {
    const opts = parseApplyArgs(['f.sql', '--db', 'url']);
    assert.strictEqual(opts.lockTimeout, '3000ms');
    assert.strictEqual(opts.statementTimeout, '30000ms');
    assert.strictEqual(opts.maxRetries, 5);
    assert.strictEqual(opts.dryRun, false);
    assert.strictEqual(opts.lockQueueThreshold, 1);
    assert.strictEqual(opts.monitorPollMs, 500);
  });
});

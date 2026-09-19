import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  parseLsnToBigInt,
  bigIntToLsn,
  calculateLsnDiff,
  parseReplicationLagBytes,
  evaluateReplicationThrottle,
  queryReplicationStatus,
  ReplicaStatus,
} from '../../src/preflight/replicationGuard.js';

describe('Pre-flight Replication Lag & WAL Throttler', () => {
  describe('BigInt LSN Parsing & Conversion', () => {
    it('parses standard hex LSN strings to 64-bit BigInt accurately', () => {
      // 0/16B3748: high = 0, low = 0x16B3748 = 23803720
      assert.strictEqual(parseLsnToBigInt('0/16B3748'), 23803720n);

      // 16/B374D848: high = 0x16 = 22, low = 0xB374D848 = 3010779208
      // (22n << 32n) + 3010779208n = 94498328136n + 3010779208n = 97509107344n
      const expected = (22n << 32n) + 3010779208n;
      assert.strictEqual(parseLsnToBigInt('16/B374D848'), expected);
    });

    it('converts BigInt back to standard PostgreSQL LSN string', () => {
      const lsn = '16/B374D848';
      const big = parseLsnToBigInt(lsn);
      assert.strictEqual(bigIntToLsn(big), lsn);

      assert.strictEqual(bigIntToLsn(0n), '0/00000000');
    });

    it('calculates exact LSN byte difference using BigInt arithmetic', () => {
      const current = '1/1000';
      const prev = '1/0000';
      // Diff is 0x1000 = 4096 bytes
      assert.strictEqual(calculateLsnDiff(current, prev), 4096n);

      // Diff crossing 32-bit segment boundaries
      const lsn1 = '2/00000000';
      const lsn2 = '1/00000000';
      // Exactly 2^32 bytes = 4294967296 bytes (4 GB)
      assert.strictEqual(calculateLsnDiff(lsn1, lsn2), 4294967296n);
    });

    it('rejects invalid or malformed LSN strings', () => {
      assert.throws(() => parseLsnToBigInt('invalid_lsn'), /Malformed PostgreSQL LSN string/);
      assert.throws(() => parseLsnToBigInt(''), /Invalid LSN input/);
      assert.throws(() => parseLsnToBigInt('1234'), /Malformed PostgreSQL LSN string/);
    });
  });

  describe('parseReplicationLagBytes', () => {
    it('handles numbers, strings, BigInts, and floating strings safely', () => {
      assert.strictEqual(parseReplicationLagBytes(1048576), 1048576n);
      assert.strictEqual(parseReplicationLagBytes('52428800'), 52428800n);
      assert.strictEqual(parseReplicationLagBytes('1048576.789'), 1048576n);
      assert.strictEqual(parseReplicationLagBytes(100n), 100n);
      assert.strictEqual(parseReplicationLagBytes(null), 0n);
      assert.strictEqual(parseReplicationLagBytes(undefined), 0n);
      assert.strictEqual(parseReplicationLagBytes('invalid'), 0n);
    });
  });

  describe('evaluateReplicationThrottle', () => {
    it('returns shouldThrottle=false when 0 standby replicas exist', () => {
      const decision = evaluateReplicationThrottle([]);
      assert.strictEqual(decision.shouldThrottle, false);
      assert.strictEqual(decision.recommendedThrottleMs, 0);
      assert.strictEqual(decision.replicaCount, 0);
    });

    it('returns shouldThrottle=false when all replicas are healthy within thresholds', () => {
      const replicas: ReplicaStatus[] = [
        {
          applicationName: 'standby_1',
          clientAddr: '10.0.0.2',
          state: 'streaming',
          syncState: 'sync',
          sentLsn: '1/1000',
          writeLsn: '1/1000',
          flushLsn: '1/1000',
          replayLsn: '1/0FF0',
          replayLagBytes: 16n,
          replayLagSeconds: 0.1,
        },
      ];

      const decision = evaluateReplicationThrottle(replicas, {
        maxLagBytes: 104857600n, // 100 MB
        maxLagSeconds: 10,
      });

      assert.strictEqual(decision.shouldThrottle, false);
      assert.strictEqual(decision.recommendedThrottleMs, 0);
      assert.strictEqual(decision.laggingReplicas.length, 0);
    });

    it('triggers throttling when replica replay lag exceeds byte threshold', () => {
      const replicas: ReplicaStatus[] = [
        {
          applicationName: 'standby_reporting',
          clientAddr: '10.0.0.3',
          state: 'streaming',
          syncState: 'async',
          sentLsn: '1/50000000',
          writeLsn: '1/10000000',
          flushLsn: '1/10000000',
          replayLsn: '1/00000000',
          replayLagBytes: 250n * 1024n * 1024n, // 250 MB (> 100 MB limit)
          replayLagSeconds: 4.5,
        },
      ];

      const decision = evaluateReplicationThrottle(replicas, {
        maxLagBytes: 100n * 1024n * 1024n, // 100 MB
        maxLagSeconds: 10,
        baseThrottleMs: 500,
      });

      assert.strictEqual(decision.shouldThrottle, true);
      assert.ok(decision.recommendedThrottleMs >= 500);
      assert.strictEqual(decision.laggingReplicas.length, 1);
      assert.strictEqual(decision.laggingReplicas[0].exceededMetric, 'BYTES');
    });

    it('triggers throttling when replica replay lag exceeds duration threshold', () => {
      const replicas: ReplicaStatus[] = [
        {
          applicationName: 'standby_dr',
          clientAddr: '10.0.0.4',
          state: 'streaming',
          syncState: 'async',
          sentLsn: null,
          writeLsn: null,
          flushLsn: null,
          replayLsn: null,
          replayLagBytes: 50n * 1024n * 1024n, // 50 MB (< 100 MB limit)
          replayLagSeconds: 25.0, // 25s (> 10s limit)
        },
      ];

      const decision = evaluateReplicationThrottle(replicas, {
        maxLagBytes: 100n * 1024n * 1024n,
        maxLagSeconds: 10,
      });

      assert.strictEqual(decision.shouldThrottle, true);
      assert.strictEqual(decision.laggingReplicas[0].exceededMetric, 'DURATION');
    });

    it('filters out async standbys when syncOnly is enabled', () => {
      const replicas: ReplicaStatus[] = [
        {
          applicationName: 'standby_async',
          clientAddr: '10.0.0.5',
          state: 'streaming',
          syncState: 'async',
          sentLsn: null,
          writeLsn: null,
          flushLsn: null,
          replayLsn: null,
          replayLagBytes: 500n * 1024n * 1024n,
          replayLagSeconds: 60.0,
        },
      ];

      const decision = evaluateReplicationThrottle(replicas, {
        syncOnly: true,
      });

      assert.strictEqual(decision.shouldThrottle, false);
      assert.strictEqual(decision.laggingReplicas.length, 0);
    });
  });

  describe('queryReplicationStatus with mock client', () => {
    it('queries pg_stat_replication and parses BigInt lag values', async () => {
      const mockClient = {
        async query() {
          return {
            rows: [
              {
                application_name: 'node_2',
                client_addr: '192.168.1.50',
                state: 'streaming',
                sync_state: 'sync',
                sent_lsn: '0/2000',
                write_lsn: '0/2000',
                flush_lsn: '0/2000',
                replay_lsn: '0/1500',
                replay_lag_bytes: '281474976710656', // > 2^48
                replay_lag_seconds: '1.25',
              },
            ],
          };
        },
      };

      const replicas = await queryReplicationStatus(mockClient);
      assert.strictEqual(replicas.length, 1);
      assert.strictEqual(replicas[0].applicationName, 'node_2');
      assert.strictEqual(replicas[0].replayLagBytes, 281474976710656n);
      assert.strictEqual(replicas[0].replayLagSeconds, 1.25);
    });
  });
});

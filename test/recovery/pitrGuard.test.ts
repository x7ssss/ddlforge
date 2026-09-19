import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  classifyArchiverStatus,
  evaluateArchiverHealth,
  evaluateSlotHealth,
  queryArchiverStatus,
  queryReplicationSlots,
  queryStandbyLsnStatus,
  auditDisasterReadiness,
  formatDoctorReportTerminal,
  ArchiverStat,
  ReplicationSlotInfo,
} from '../../src/recovery/pitrGuard.js';

describe('PITR Guard & Continuous Archiving Health (src/recovery/pitrGuard.ts)', () => {
  const baseTime = new Date('2026-09-19T12:00:00.000Z');

  describe('classifyArchiverStatus', () => {
    it('classifies NEVER_ARCHIVED when archived_count is 0 and no WAL archived', () => {
      const stat: Partial<ArchiverStat> = {
        archivedCount: 0n,
        failedCount: 0n,
        lastArchivedWal: null,
        lastArchivedTime: null,
      };

      const status = classifyArchiverStatus(stat, baseTime);
      assert.strictEqual(status, 'NEVER_ARCHIVED');
    });

    it('classifies FAILING_NOW when attempts failed with 0 successful archives', () => {
      const stat: Partial<ArchiverStat> = {
        archivedCount: 0n,
        failedCount: 3n,
        lastArchivedWal: null,
        lastArchivedTime: null,
        lastFailedWal: '000000010000000000000001',
        lastFailedTime: new Date(baseTime.getTime() - 5 * 60 * 1000), // 5 min ago
      };

      const status = classifyArchiverStatus(stat, baseTime);
      assert.strictEqual(status, 'FAILING_NOW');
    });

    it('classifies FAILING_NOW when last failure occurred after last successful archive', () => {
      const stat: Partial<ArchiverStat> = {
        archivedCount: 150n,
        failedCount: 2n,
        lastArchivedWal: '00000001000000000000000A',
        lastArchivedTime: new Date(baseTime.getTime() - 10 * 60 * 1000), // 10 min ago
        lastFailedWal: '00000001000000000000000B',
        lastFailedTime: new Date(baseTime.getTime() - 2 * 60 * 1000), // 2 min ago (more recent)
      };

      const status = classifyArchiverStatus(stat, baseTime);
      assert.strictEqual(status, 'FAILING_NOW');
    });

    it('classifies RECOVERED when archive succeeded after a past failure within healthy window', () => {
      const stat: Partial<ArchiverStat> = {
        archivedCount: 200n,
        failedCount: 5n,
        lastFailedWal: '000000010000000000000010',
        lastFailedTime: new Date(baseTime.getTime() - 30 * 60 * 1000), // 30 min ago
        lastArchivedWal: '000000010000000000000011',
        lastArchivedTime: new Date(baseTime.getTime() - 3 * 60 * 1000), // 3 min ago (succeeded after failure!)
      };

      const status = classifyArchiverStatus(stat, baseTime);
      assert.strictEqual(status, 'RECOVERED');
    });

    it('classifies HEALTHY when archive succeeded recently with zero failures', () => {
      const stat: Partial<ArchiverStat> = {
        archivedCount: 500n,
        failedCount: 0n,
        lastArchivedWal: '000000010000000000000050',
        lastArchivedTime: new Date(baseTime.getTime() - 4 * 60 * 1000), // 4 min ago (within 15m threshold)
        lastFailedTime: null,
      };

      const status = classifyArchiverStatus(stat, baseTime);
      assert.strictEqual(status, 'HEALTHY');
    });

    it('classifies STALE_ARCHIVE when last archive is older than stale interval (default 15 mins)', () => {
      const stat: Partial<ArchiverStat> = {
        archivedCount: 350n,
        failedCount: 0n,
        lastArchivedWal: '000000010000000000000030',
        lastArchivedTime: new Date(baseTime.getTime() - 25 * 60 * 1000), // 25 min ago (> 15 min)
        lastFailedTime: null,
      };

      const status = classifyArchiverStatus(stat, baseTime);
      assert.strictEqual(status, 'STALE_ARCHIVE');
    });

    it('classifies STALE_ARCHIVE when past failures exist but last successful archive is stale', () => {
      const stat: Partial<ArchiverStat> = {
        archivedCount: 120n,
        failedCount: 1n,
        lastFailedTime: new Date(baseTime.getTime() - 2 * 3600 * 1000), // 2h ago
        lastArchivedWal: '000000010000000000000020',
        lastArchivedTime: new Date(baseTime.getTime() - 40 * 60 * 1000), // 40 min ago (> 15m)
      };

      const status = classifyArchiverStatus(stat, baseTime);
      assert.strictEqual(status, 'STALE_ARCHIVE');
    });

    it('respects custom staleIntervalMs and failureIntervalMs thresholds', () => {
      const stat: Partial<ArchiverStat> = {
        archivedCount: 100n,
        failedCount: 0n,
        lastArchivedTime: new Date(baseTime.getTime() - 10 * 60 * 1000), // 10 min ago
      };

      // With 5-minute threshold, 10 min ago is stale
      const status1 = classifyArchiverStatus(stat, baseTime, { staleIntervalMs: 5 * 60 * 1000 });
      assert.strictEqual(status1, 'STALE_ARCHIVE');

      // With 30-minute threshold, 10 min ago is healthy
      const status2 = classifyArchiverStatus(stat, baseTime, { staleIntervalMs: 30 * 60 * 1000 });
      assert.strictEqual(status2, 'HEALTHY');
    });
  });

  describe('evaluateArchiverHealth', () => {
    it('produces structured report with timestamps and health message', () => {
      const stat: ArchiverStat = {
        archivedCount: 1000n,
        failedCount: 0n,
        lastArchivedWal: '0000000100000000000000AA',
        lastArchivedTime: new Date(baseTime.getTime() - 120 * 1000), // 2 min ago
        lastFailedWal: null,
        lastFailedTime: null,
        statsReset: new Date('2026-09-01T00:00:00Z'),
      };

      const report = evaluateArchiverHealth(stat, { now: baseTime });
      assert.strictEqual(report.status, 'HEALTHY');
      assert.strictEqual(report.isHealthy, true);
      assert.strictEqual(report.secondsSinceLastArchive, 120);
      assert.strictEqual(report.secondsSinceLastFailure, null);
      assert.match(report.message, /1000 segments archived/);
    });
  });

  describe('Replication Slot Health & Danger Detection', () => {
    it('flags slots in "lost" status as dangerous blockers', () => {
      const slots: ReplicationSlotInfo[] = [
        {
          slotName: 'standby_replica_1',
          plugin: null,
          slotType: 'physical',
          active: false,
          temporary: false,
          walStatus: 'lost',
          restartLsn: '0/1000000',
          confirmedFlushLsn: null,
          retainedBytes: 5000000n,
          isDangerous: false,
        },
      ];

      const report = evaluateSlotHealth(slots);
      assert.strictEqual(report.hasDangerousSlots, true);
      assert.strictEqual(report.dangerousSlots.length, 1);
      assert.match(report.dangerousSlots[0].dangerReason!, /lost required WAL segments/);
    });

    it('flags slots in "unreserved" status as dangerous blockers', () => {
      const slots: ReplicationSlotInfo[] = [
        {
          slotName: 'cdc_debezium_slot',
          plugin: 'pgoutput',
          slotType: 'logical',
          active: true,
          temporary: false,
          walStatus: 'unreserved',
          restartLsn: '0/2000000',
          confirmedFlushLsn: '0/2000000',
          retainedBytes: 10000000n,
          isDangerous: false,
        },
      ];

      const report = evaluateSlotHealth(slots);
      assert.strictEqual(report.hasDangerousSlots, true);
      assert.strictEqual(report.dangerousSlots.length, 1);
      assert.match(report.dangerousSlots[0].dangerReason!, /unreserved status/);
    });

    it('flags slots in "extended" status as dangerous blockers', () => {
      const slots: ReplicationSlotInfo[] = [
        {
          slotName: 'standby_dr',
          plugin: null,
          slotType: 'physical',
          active: true,
          temporary: false,
          walStatus: 'extended',
          restartLsn: '0/3000000',
          confirmedFlushLsn: null,
          retainedBytes: 50000000n,
          isDangerous: false,
        },
      ];

      const report = evaluateSlotHealth(slots);
      assert.strictEqual(report.hasDangerousSlots, true);
      assert.strictEqual(report.dangerousSlots.length, 1);
      assert.match(report.dangerousSlots[0].dangerReason!, /extended status/);
    });

    it('flags inactive slots pinning over 1GB of WAL as dangerous bloat hazards', () => {
      const slots: ReplicationSlotInfo[] = [
        {
          slotName: 'stale_abandoned_slot',
          plugin: 'test_decoding',
          slotType: 'logical',
          active: false,
          temporary: false,
          walStatus: 'normal',
          restartLsn: '0/1000000',
          confirmedFlushLsn: null,
          retainedBytes: 2147483648n, // 2 GB
          isDangerous: false,
        },
      ];

      const report = evaluateSlotHealth(slots);
      assert.strictEqual(report.hasDangerousSlots, true);
      assert.strictEqual(report.hasInactiveSlots, true);
      assert.strictEqual(report.dangerousSlots.length, 1);
      assert.match(report.dangerousSlots[0].dangerReason!, /pinning 2048 MB of WAL/);
    });

    it('evaluates normal active slots as clean and non-dangerous', () => {
      const slots: ReplicationSlotInfo[] = [
        {
          slotName: 'healthy_standby',
          plugin: null,
          slotType: 'physical',
          active: true,
          temporary: false,
          walStatus: 'normal',
          restartLsn: '1/00000000',
          confirmedFlushLsn: null,
          retainedBytes: 16777216n, // 16 MB (1 segment)
          isDangerous: false,
        },
      ];

      const report = evaluateSlotHealth(slots);
      assert.strictEqual(report.hasDangerousSlots, false);
      assert.strictEqual(report.hasInactiveSlots, false);
      assert.strictEqual(report.totalRetainedBytes, 16777216n);
    });
  });

  describe('Database Mock Queries & auditDisasterReadiness', () => {
    it('executes full audit and reports readiness when healthy', async () => {
      const mockClient = {
        async query(sql: string) {
          if (sql.includes('pg_stat_archiver')) {
            return {
              rows: [
                {
                  archived_count: '250',
                  last_archived_wal: '00000001000000000000000F',
                  last_archived_time: new Date(baseTime.getTime() - 60000).toISOString(),
                  failed_count: '0',
                  last_failed_wal: null,
                  last_failed_time: null,
                  stats_reset: null,
                },
              ],
            };
          }
          if (sql.includes('pg_is_in_recovery') || sql.includes('cur_lsn')) {
            return { rows: [{ cur_lsn: '1/10000000' }] };
          }
          if (sql.includes('pg_stat_replication')) {
            return {
              rows: [
                {
                  application_name: 'replica_1',
                  client_addr: '10.0.0.5',
                  state: 'streaming',
                  sync_state: 'sync',
                  replay_lsn: '1/10000000', // 0 lag
                },
              ],
            };
          }
          if (sql.includes('pg_replication_slots')) {
            return {
              rows: [
                {
                  slot_name: 'slot_replica_1',
                  plugin: null,
                  slot_type: 'physical',
                  active: true,
                  temporary: false,
                  wal_status: 'normal',
                  restart_lsn: '1/0FF00000',
                  confirmed_flush_lsn: null,
                },
              ],
            };
          }
          return { rows: [] };
        },
      };

      const report = await auditDisasterReadiness(mockClient, { now: baseTime });
      assert.strictEqual(report.isReady, true);
      assert.strictEqual(report.blockers.length, 0);
      assert.strictEqual(report.archiver.status, 'HEALTHY');
      assert.strictEqual(report.replicationSlots.hasDangerousSlots, false);
      assert.strictEqual(report.standbys.hasLaggingStandby, false);

      const terminal = formatDoctorReportTerminal(report);
      assert.match(terminal, /DISASTER RECOVERY READINESS: HEALTHY/);
      assert.match(terminal, /WAL ARCHIVING/);
    });

    it('reports blockers when archiver is failing and slot has lost WAL', async () => {
      const mockClient = {
        async query(sql: string) {
          if (sql.includes('pg_stat_archiver')) {
            return {
              rows: [
                {
                  archived_count: '50',
                  last_archived_wal: '000000010000000000000005',
                  last_archived_time: new Date(baseTime.getTime() - 3600000).toISOString(), // 1h ago
                  failed_count: '12',
                  last_failed_wal: '000000010000000000000006',
                  last_failed_time: new Date(baseTime.getTime() - 60000).toISOString(), // 1m ago
                  stats_reset: null,
                },
              ],
            };
          }
          if (sql.includes('cur_lsn')) {
            return { rows: [{ cur_lsn: '1/20000000' }] };
          }
          if (sql.includes('pg_stat_replication')) {
            return { rows: [] };
          }
          if (sql.includes('pg_replication_slots')) {
            return {
              rows: [
                {
                  slot_name: 'broken_slot',
                  plugin: null,
                  slot_type: 'physical',
                  active: false,
                  temporary: false,
                  wal_status: 'lost',
                  restart_lsn: '0/10000000',
                  confirmed_flush_lsn: null,
                },
              ],
            };
          }
          return { rows: [] };
        },
      };

      const report = await auditDisasterReadiness(mockClient, { now: baseTime });
      assert.strictEqual(report.isReady, false);
      assert.strictEqual(report.blockers.length >= 2, true);
      assert.match(report.blockers[0], /WAL archiving is FAILING NOW/);
      assert.match(report.blockers[1], /lost required WAL segments/);

      const terminal = formatDoctorReportTerminal(report);
      assert.match(terminal, /DISASTER RECOVERY READINESS: COMPROMISED/);
    });
  });
});

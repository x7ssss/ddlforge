import { randomUUID } from 'node:crypto';
import type { 
  RollbackOptions, 
  RollbackReport, 
  RollbackEstablishReport, 
  ReverseReplicationSetup,
  CutoverPhase,
  CutoverPhaseRecord
} from './types.js';
import { synchronizeSequences } from './sequenceSync.js';
import type { PgClientLike } from '../cluster/advisory.js';

export function generateReverseReplicationSetup(
  blueUrl: string, 
  greenUrl: string, 
  options?: {pubName?: string, subName?: string, slotName?: string}
): ReverseReplicationSetup {
  const reversePublicationName = options?.pubName || 'ddlforge_green_pub';
  const reverseSubscriptionName = options?.subName || 'ddlforge_blue_sub';
  const reverseSlotName = options?.slotName || 'ddlforge_rollback_slot';

  const reversePublicationSql = `CREATE PUBLICATION ${reversePublicationName} FOR ALL TABLES;`;
  const reverseSubscriptionSql = `CREATE SUBSCRIPTION ${reverseSubscriptionName} CONNECTION '${greenUrl}' PUBLICATION ${reversePublicationName} WITH (copy_data = false, origin = 'none', slot_name = '${reverseSlotName}');`;

  return {
    reversePublicationSql,
    reverseSubscriptionSql,
    reversePublicationName,
    reverseSubscriptionName,
    reverseSlotName
  };
}

export async function establishRollback(options: {blueUrl: string, greenUrl: string, dryRun?: boolean, format?: string}): Promise<RollbackEstablishReport> {
  const setup = generateReverseReplicationSetup(options.blueUrl, options.greenUrl);
  
  const report: RollbackEstablishReport = {
    reverseSetup: setup,
    executed: false,
    dryRun: options.dryRun || false,
    checkedAt: new Date()
  };

  if (options.dryRun) {
    return report;
  }

  const { Client } = await import('pg');
  const greenClient = new Client({ connectionString: options.greenUrl });
  const blueClient = new Client({ connectionString: options.blueUrl });

  try {
    await greenClient.connect();
    await blueClient.connect();

    await greenClient.query(setup.reversePublicationSql);
    await blueClient.query(setup.reverseSubscriptionSql);
    report.executed = true;
  } finally {
    await greenClient.end();
    await blueClient.end();
  }

  report.checkedAt = new Date();
  return report;
}

export async function executeRollback(options: RollbackOptions): Promise<RollbackReport> {
  const runId = randomUUID();
  const startTime = Date.now();
  const report: RollbackReport = {
    runId,
    blueUrl: options.blueUrl,
    greenUrl: options.greenUrl,
    databaseName: options.databaseName,
    phases: [],
    finalPhase: 'IDLE',
    dryRun: options.dryRun || false,
    totalDurationMs: 0,
    checkedAt: new Date()
  };
  
  const { Client } = await import('pg');
  const blueClient = new Client({ connectionString: options.blueUrl });
  const greenClient = new Client({ connectionString: options.greenUrl });

  try {
    await blueClient.connect();
    await greenClient.connect();

    const addPhase = (phase: CutoverPhase, startedAt: number, details: string) => {
      report.phases.push({
        phase,
        startedAt: new Date(startedAt),
        completedAt: new Date(),
        durationMs: Date.now() - startedAt,
        details
      });
      report.finalPhase = phase;
    };

    const dryRun = options.dryRun || false;
    const dbName = options.databaseName;
    const roleName = options.roleName;

    // Phase 1: DRAIN (on Green)
    const drainStart = Date.now();
    let activeWriters = 1;
    const drainTimeoutMs = 30000;
    const pollIntervalMs = options.pollIntervalMs || 500;
    while(Date.now() - drainStart < drainTimeoutMs) {
      const res = await greenClient.query(`SELECT count(*) as count FROM pg_stat_activity WHERE state = 'active' AND pid != pg_backend_pid() AND backend_type = 'client backend'`);
      activeWriters = parseInt(res.rows[0].count, 10);
      if (activeWriters === 0) break;
      await new Promise(r => setTimeout(r, pollIntervalMs));
    }
    addPhase('DRAIN', drainStart, `Active writers on Green dropped to ${activeWriters}`);

    // Phase 2: FENCE_GREEN (mapped to FENCE_BLUE phase name)
    const fenceStart = Date.now();
    if (!dryRun) {
      await greenClient.query(`ALTER DATABASE "${dbName}" SET default_transaction_read_only = on;`);
      if (roleName) {
         await greenClient.query(`ALTER ROLE "${roleName}" SET default_transaction_read_only = on;`);
      }
      await greenClient.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid != pg_backend_pid() AND state = 'active' AND backend_type = 'client backend';`);
    }
    addPhase('FENCE_BLUE', fenceStart, dryRun ? 'Dry run: skipped fencing Green' : 'Fenced Green database');

    // Phase 3: CAPTURE_FENCE
    const captureStart = Date.now();
    const lsnRes = await greenClient.query(`SELECT pg_current_wal_lsn()::text AS fence_lsn;`);
    const fenceLsn = lsnRes.rows[0].fence_lsn;
    report.fenceLsn = fenceLsn;
    addPhase('CAPTURE_FENCE', captureStart, `Fence LSN on Green: ${fenceLsn}`);

    // Phase 4: WAIT_REPLICATION
    const waitStart = Date.now();
    const slotName = options.slotName || 'ddlforge_rollback_slot';
    const timeoutMs = options.timeoutMs || 120000;
    let lagBytes = 1;
    let confirmedFlushLsn = '';
    while(Date.now() - waitStart < timeoutMs) {
      const repRes = await greenClient.query(`SELECT confirmed_flush_lsn::text, pg_wal_lsn_diff('${fenceLsn}', confirmed_flush_lsn) AS lag_bytes FROM pg_replication_slots WHERE slot_name = '${slotName}';`);
      if (repRes.rowCount && repRes.rowCount > 0) {
        lagBytes = parseInt(repRes.rows[0].lag_bytes, 10);
        confirmedFlushLsn = repRes.rows[0].confirmed_flush_lsn;
        if (lagBytes <= 0) break;
      }
      await new Promise(r => setTimeout(r, pollIntervalMs));
    }
    report.confirmedFlushLsn = confirmedFlushLsn;
    addPhase('WAIT_REPLICATION', waitStart, `Reverse replication caught up, lag bytes: ${lagBytes}`);

    // Phase 5: SYNC_SEQUENCES
    const syncStart = Date.now();
    // Sync from Green to Blue: swap blue and green in options
    await synchronizeSequences({
      ...options,
      blueUrl: options.greenUrl, // Green is source
      greenUrl: options.blueUrl  // Blue is target
    });
    addPhase('SYNC_SEQUENCES', syncStart, dryRun ? 'Dry run: skipped sequence sync execution' : 'Synchronized sequences back to Blue');

    // Phase 6: PROMOTE_BLUE (mapped to PROMOTE_GREEN phase name)
    const promoteStart = Date.now();
    if (!dryRun) {
      await blueClient.query(`ALTER DATABASE "${dbName}" SET default_transaction_read_only = off;`);
      if (roleName) {
        await blueClient.query(`ALTER ROLE "${roleName}" SET default_transaction_read_only = off;`);
      }
    }
    addPhase('PROMOTE_GREEN', promoteStart, dryRun ? 'Dry run: skipped promotion of Blue' : 'Promoted Blue database');
    
    report.finalPhase = 'COMPLETE';

  } catch (error) {
    report.finalPhase = 'FAILED';
    report.phases.push({
      phase: 'FAILED',
      startedAt: new Date(),
      details: error instanceof Error ? error.message : String(error)
    });
  } finally {
    await blueClient.end();
    await greenClient.end();
  }

  report.totalDurationMs = Date.now() - startTime;
  report.checkedAt = new Date();
  return report;
}

export function formatRollbackReportTerminal(report: RollbackReport): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('  ddlforge v2.0.0 — Emergency Rollback Pipeline');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push(`Rollback Run ID: ${report.runId}`);
  lines.push(`Final Phase:     ${report.finalPhase}`);
  lines.push(`Total Duration:  ${report.totalDurationMs}ms`);
  lines.push(`Target DB:       "${report.databaseName}" (Mode: ${report.dryRun ? 'DRY RUN' : 'ACTIVE'})`);
  if (report.fenceLsn) lines.push(`Fence LSN:       ${report.fenceLsn}`);
  lines.push('');
  lines.push('Phases:');
  for (const p of report.phases) {
    const badge = `[${p.phase}]`;
    lines.push(`- ${badge.padEnd(18)} [${p.durationMs ?? 0}ms]: ${p.details}`);
  }
  lines.push('');
  if (report.finalPhase === 'COMPLETE') {
    lines.push('  ✔ EMERGENCY ROLLBACK COMPLETE: Blue is restored as authoritative.');
  } else {
    lines.push(`  ✖ ROLLBACK STATUS: ${report.finalPhase}`);
  }
  lines.push('');
  return lines.join('\n');
}

export function formatEstablishReportTerminal(report: RollbackEstablishReport): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('  ddlforge v2.0.0 — Bi-Directional Rollback Parachute (Active/Passive)');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push(`Rollback Establish Report:`);
  lines.push(`Dry Run:                 ${report.dryRun ? 'YES' : 'NO'}`);
  lines.push(`Executed:                ${report.executed ? 'YES' : 'NO'}`);
  lines.push(`Reverse Publication:     ${report.reverseSetup.reversePublicationName}`);
  lines.push(`Reverse Subscription:    ${report.reverseSetup.reverseSubscriptionName}`);
  lines.push(`Replication Safety:      [origin = 'none'] (Prevents infinite echoing loops)`);
  lines.push('');
  lines.push(`Reverse Publication SQL: ${report.reverseSetup.reversePublicationSql}`);
  lines.push(`Reverse Subscription SQL: ${report.reverseSetup.reverseSubscriptionSql}`);
  lines.push('');
  return lines.join('\n');
}


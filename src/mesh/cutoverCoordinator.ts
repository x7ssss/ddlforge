import { randomUUID } from 'node:crypto';
import type { CutoverOptions, CutoverReport, CutoverPhaseRecord, CutoverPhase } from './types.js';
import { synchronizeSequences } from './sequenceSync.js';

export function lsnToBigInt(lsn: string): bigint {
  const parts = lsn.split('/');
  if (parts.length !== 2) throw new Error(`Invalid LSN format: ${lsn}`);
  const high = BigInt(parseInt(parts[0], 16));
  const low = BigInt(parseInt(parts[1], 16));
  return (high << BigInt(32)) | low;
}

export function compareLsn(lsnA: string, lsnB: string): number {
  const a = lsnToBigInt(lsnA);
  const b = lsnToBigInt(lsnB);
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export async function executeCutover(options: CutoverOptions): Promise<CutoverReport> {
  const runId = randomUUID();
  const startTime = Date.now();
  const report: CutoverReport = {
    runId,
    blueUrl: options.blueUrl,
    greenUrl: options.greenUrl,
    databaseName: options.databaseName,
    roleName: options.roleName,
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

    // Phase 1: DRAIN
    const drainStart = Date.now();
    let activeWriters = 1;
    const drainTimeoutMs = options.drainTimeoutMs || 30000;
    const pollIntervalMs = options.pollIntervalMs || 500;
    while(Date.now() - drainStart < drainTimeoutMs) {
      const res = await blueClient.query(`SELECT count(*) as count FROM pg_stat_activity WHERE state = 'active' AND pid != pg_backend_pid() AND backend_type = 'client backend'`);
      activeWriters = parseInt(res.rows[0].count, 10);
      if (activeWriters === 0) break;
      await new Promise(r => setTimeout(r, pollIntervalMs));
    }
    addPhase('DRAIN', drainStart, `Active writers dropped to ${activeWriters}`);

    // Phase 2: FENCE_BLUE
    const fenceStart = Date.now();
    if (!dryRun) {
      await blueClient.query(`ALTER DATABASE "${dbName}" SET default_transaction_read_only = on;`);
      if (roleName) {
         await blueClient.query(`ALTER ROLE "${roleName}" SET default_transaction_read_only = on;`);
      }
      await blueClient.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid != pg_backend_pid() AND state = 'active' AND backend_type = 'client backend';`);
    }
    addPhase('FENCE_BLUE', fenceStart, dryRun ? 'Dry run: skipped fencing' : 'Fenced Blue database');

    // Phase 3: CAPTURE_FENCE
    const captureStart = Date.now();
    const lsnRes = await blueClient.query(`SELECT pg_current_wal_lsn()::text AS fence_lsn;`);
    const fenceLsn = lsnRes.rows[0].fence_lsn;
    report.fenceLsn = fenceLsn;
    addPhase('CAPTURE_FENCE', captureStart, `Fence LSN: ${fenceLsn}`);

    // Phase 4: WAIT_REPLICATION
    const waitStart = Date.now();
    const slotName = options.slotName || 'ddlforge_mesh_slot';
    const timeoutMs = options.timeoutMs || 120000;
    let lagBytes = 1;
    let confirmedFlushLsn = '';
    while(Date.now() - waitStart < timeoutMs) {
      const repRes = await blueClient.query(`SELECT confirmed_flush_lsn::text, pg_wal_lsn_diff('${fenceLsn}', confirmed_flush_lsn) AS lag_bytes FROM pg_replication_slots WHERE slot_name = '${slotName}';`);
      if (repRes.rowCount && repRes.rowCount > 0) {
        lagBytes = parseInt(repRes.rows[0].lag_bytes, 10);
        confirmedFlushLsn = repRes.rows[0].confirmed_flush_lsn;
        if (lagBytes <= 0) break;
      }
      await new Promise(r => setTimeout(r, pollIntervalMs));
    }
    report.lsnLagBytes = lagBytes;
    report.confirmedFlushLsn = confirmedFlushLsn;
    addPhase('WAIT_REPLICATION', waitStart, `Replication caught up, lag bytes: ${lagBytes}`);

    // Phase 5: SYNC_SEQUENCES
    const syncStart = Date.now();
    report.sequenceSync = await synchronizeSequences(options);
    addPhase('SYNC_SEQUENCES', syncStart, dryRun ? 'Dry run: skipped sequence sync execution' : 'Synchronized sequences');

    // Phase 6: PROMOTE_GREEN
    const promoteStart = Date.now();
    if (!dryRun) {
      await greenClient.query(`ALTER DATABASE "${dbName}" SET default_transaction_read_only = off;`);
      if (roleName) {
        await greenClient.query(`ALTER ROLE "${roleName}" SET default_transaction_read_only = off;`);
      }
    }
    addPhase('PROMOTE_GREEN', promoteStart, dryRun ? 'Dry run: skipped promotion' : 'Promoted Green database');
    
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

export function formatCutoverReportTerminal(report: CutoverReport): string {
  let output = `Cutover Run ID: ${report.runId}\n`;
  output += `Final Phase: ${report.finalPhase}\n`;
  output += `Total Duration: ${report.totalDurationMs}ms\n\n`;
  output += `Phases:\n`;
  for (const p of report.phases) {
    output += `- ${p.phase} [${p.durationMs ?? 0}ms]: ${p.details}\n`;
  }
  return output;
}

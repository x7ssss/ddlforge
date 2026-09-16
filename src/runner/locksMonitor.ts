/**
 * ddlforge - Background lock-queue monitor for PostgreSQL execution supervisor.
 *
 * During DDL execution the monitor periodically queries pg_locks and
 * pg_stat_activity to detect when other backends are queuing behind the
 * migration's exclusive lock.  If the queue depth exceeds a configurable
 * threshold the monitor cancels the migration backend via pg_cancel_backend()
 * and sets the `avalanche` flag so the executor can surface a clear error.
 *
 * Design notes
 * ────────────
 * • Uses a separate Client connection so it never shares the migration
 *   transaction (avoids deadlock on the monitor itself).
 * • All monitor queries use SHORT local timeouts so a hung Postgres cannot
 *   also jam the monitor.
 * • The monitor resolves its returned promise with a MonitorResult when it
 *   self-terminates; callers must await that to detect the avalanche flag.
 */

/* ------------------------------------------------------------------ */
/* Type imports — pg is always dynamically imported in executor.ts;    */
/* we re-use the same dynamic approach here to keep the module clean.  */
/* ------------------------------------------------------------------ */

export interface MonitorOptions {
  /** PID of the migration backend being guarded */
  migrationPid: number;
  /**
   * Factory that returns a fresh client already connected to the database.
   * The monitor will call end() on it when done.
   */
  clientFactory: () => Promise<MonitorClient>;
  /** Milliseconds between each poll (default: 500 ms) */
  pollIntervalMs?: number;
  /**
   * Number of waiting backends that triggers a cancellation
   * (default: 1 – i.e. cancel as soon as even one query is blocked).
   */
  queueThreshold?: number;
  /** AbortSignal: when aborted the monitor stops without cancelling */
  signal?: AbortSignal;
}

/**
 * Minimal pg Client interface required by the monitor.
 * Using a structural type allows tests to inject simple mocks.
 */
export interface MonitorClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

export interface MonitorResult {
  /** True when the monitor detected a queue avalanche and cancelled the backend */
  avalanche: boolean;
  /** Number of waiting backends detected at cancellation time */
  blockedCount: number;
  /** ISO timestamp at which cancellation was issued (empty if no cancellation) */
  cancelledAt: string;
  /** Reason the monitor stopped */
  stopReason: 'aborted' | 'avalanche' | 'error' | 'external-stop';
}

/** SQL that detects backends queuing on locks held/waited by our migration PID */
const BLOCKED_QUERY_SQL = `
  SELECT COUNT(*) AS blocked_count
  FROM  pg_locks     blocker
  JOIN  pg_locks     waiter
       ON  waiter.relation  = blocker.relation
       AND waiter.locktype  = blocker.locktype
       AND waiter.pid      <> blocker.pid
  WHERE blocker.pid    = $1
    AND blocker.granted = TRUE
    AND waiter.granted  = FALSE
`;

/** SQL that also captures pg_stat_activity info for richer diagnostics */
const BLOCKED_QUERY_WITH_ACTIVITY_SQL = `
  SELECT
    waiter_act.pid              AS waiter_pid,
    waiter_act.query            AS waiter_query,
    waiter_act.state            AS waiter_state,
    waiter_act.wait_event_type  AS wait_event_type,
    waiter_act.wait_event       AS wait_event,
    blocker.mode                AS blocker_mode
  FROM  pg_locks     blocker
  JOIN  pg_locks     waiter
       ON  waiter.relation  = blocker.relation
       AND waiter.locktype  = blocker.locktype
       AND waiter.pid      <> blocker.pid
  JOIN  pg_stat_activity waiter_act
       ON  waiter_act.pid  = waiter.pid
  WHERE blocker.pid    = $1
    AND blocker.granted = TRUE
    AND waiter.granted  = FALSE
  LIMIT 20
`;

export interface BlockedBackend {
  waiterPid: number;
  waiterQuery: string;
  waiterState: string;
  waitEventType: string;
  waitEvent: string;
  blockerMode: string;
}

/**
 * Starts a non-blocking background lock-queue monitor.
 *
 * Returns a Promise<MonitorResult> that settles when the monitor self-stops
 * (either via the AbortSignal, an avalanche cancellation, or an internal error).
 *
 * Also returns a `stop()` function that callers use to gracefully terminate
 * the monitor after successful execution.
 */
export function startLockMonitor(options: MonitorOptions): {
  result: Promise<MonitorResult>;
  stop: () => void;
} {
  const {
    migrationPid,
    clientFactory,
    pollIntervalMs  = 500,
    queueThreshold  = 1,
    signal,
  } = options;

  let externalStop = false;
  let stopResolve: (() => void) | undefined;

  const stopPromise = new Promise<void>(r => { stopResolve = r; });

  /**
   * Abort handler — fires when AbortSignal triggers from the outside
   */
  function onAbort(): void {
    stopResolve?.();
  }
  if (signal) {
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  }

  const result = (async (): Promise<MonitorResult> => {
    let client: MonitorClient | undefined;
    try {
      client = await clientFactory();

      // Set short timeouts on the monitor connection itself
      await client.query(`SET statement_timeout = '5000'`);
      await client.query(`SET lock_timeout = '2000'`);

      while (true) {
        // Yield to event loop & honour stop signals
        await Promise.race([
          new Promise<void>(r => setTimeout(r, pollIntervalMs)),
          stopPromise,
        ]);

        // Check if we were asked to stop externally or via signal
        if (externalStop || signal?.aborted) {
          signal?.removeEventListener('abort', onAbort);
          return {
            avalanche: false,
            blockedCount: 0,
            cancelledAt: '',
            stopReason: externalStop ? 'external-stop' : 'aborted',
          };
        }

        // Query queue depth
        let blockedCount = 0;
        try {
          const countResult = await client.query(BLOCKED_QUERY_SQL, [migrationPid]);
          blockedCount = parseInt(String(countResult.rows[0]?.['blocked_count'] ?? '0'), 10);
        } catch {
          // Monitor query failed — skip this cycle rather than crashing
          continue;
        }

        if (blockedCount >= queueThreshold) {
          // Gather rich diagnostics before cancellation
          let blockedBackends: BlockedBackend[] = [];
          try {
            const actResult = await client.query(BLOCKED_QUERY_WITH_ACTIVITY_SQL, [migrationPid]);
            blockedBackends = actResult.rows.map(row => ({
              waiterPid:      Number(row['waiter_pid']),
              waiterQuery:    String(row['waiter_query'] ?? ''),
              waiterState:    String(row['waiter_state'] ?? ''),
              waitEventType:  String(row['wait_event_type'] ?? ''),
              waitEvent:      String(row['wait_event'] ?? ''),
              blockerMode:    String(row['blocker_mode'] ?? ''),
            }));
            void blockedBackends; // captured for future extension / structured logging
          } catch {
            // diagnostics are best-effort; proceed to cancel regardless
          }

          // Issue pg_cancel_backend — preferred over pg_terminate_backend
          // because it gives the migration client a chance to clean up.
          try {
            await client.query('SELECT pg_cancel_backend($1)', [migrationPid]);
          } catch {
            // If cancellation itself fails (e.g. PID already gone), swallow the error
          }

          const cancelledAt = new Date().toISOString();
          signal?.removeEventListener('abort', onAbort);

          return {
            avalanche: true,
            blockedCount,
            cancelledAt,
            stopReason: 'avalanche',
          };
        }
      }
    } catch (err: unknown) {
      signal?.removeEventListener('abort', onAbort);
      return {
        avalanche: false,
        blockedCount: 0,
        cancelledAt: '',
        stopReason: 'error',
      };
    } finally {
      try { await client?.end(); } catch { /* ignore */ }
    }
  })();

  return {
    result,
    stop: () => {
      externalStop = true;
      stopResolve?.();
    },
  };
}

/**
 * Determines whether a Postgres error code represents a lock-related failure.
 *
 * 55P03 — lock_not_available  (SET LOCAL lock_timeout exceeded)
 * 57014 — query_canceled      (SET LOCAL statement_timeout exceeded, or pg_cancel_backend)
 */
export function isLockError(code: string): boolean {
  return code === '55P03' || code === '57014';
}

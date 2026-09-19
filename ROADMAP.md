# ddlforge Engineering Roadmap

## Completed Milestones
- **v0.5.x**: Baseline AST and Lock Footprint Engine (Core rules, lexer token stream, initial heuristics).
- **v0.6.x**: Lock hierarchy tree, lock contention calculation, and multi-file project analysis.
- **v0.7.0**: Modern ORM Traps & Transaction Boundaries.
  - `identity-sequence-start-with`
  - `attach-partition-missing-check`
  - `enum-recreate-table-rewrite`
  - `non-transactional-in-transaction` (Catching SQLSTATE 25001)
  - `lock-accumulation-mixed-ddl-dml`
- **v0.8.0**: Migration Orchestration & Safe Slicing.
  - Byte-offset statement slicer (`ddlforge split`) preserving comments/formatting.
  - Native SHA-256 ledger forging (`ddlforge forge --orm <prisma|drizzle>`).
  - Automated in-place remediation (`ddlforge check --fix`).
- **v0.9.0**: Virtual Schema & View-Based Expand/Contract Engine.
  - Virtual schema routing via `search_path` (`ddlforge expand <file.sql> --version <v1|v2>`).
  - Explicit `INSTEAD OF` triggers for ORM `RETURNING *` hydration and sequence capture.
  - Dual-write PL/pgSQL triggers (`IS DISTINCT FROM`, `pg_trigger_depth() < 2`).
  - Keyset-paginated asynchronous backfills (`ddlforge backfill`).
  - Contract phase 3-release teardown with advisory locking (`ddlforge contract`).

---

## ✅ v1.0.0: Production Hardening, CI/CD & Live Harness (COMPLETED)

### 1. Standalone Bundled GitHub Action (`action/`)
- Bundled TypeScript action compiled via `@vercel/ncc` into `action/dist/index.js` (CommonJS, 958kB).
- Inline PR diff annotations using workflow commands (`::error file={f},line={l},col={c},title=ddlforge::{msg}`).
- CLI flag `ddlforge check --format github` for workflow integration.
- Strict exit code evaluation: fails CI check status on `BLOCKER`, logs warnings cleanly.
- `action/action.yml`, `action/src/index.ts`, `action/package.json`, `action/tsconfig.json`.
- `npm run build:action` script bundles via `ncc`.

### 2. Ephemeral PostgreSQL Test Harness (`ddlforge test`)
- `src/harness/testHarness.ts` — `TestHarness` class + `runContainerTests()` function.
- Ephemeral PostgreSQL 17 via `@testcontainers/postgresql` (guarded by `DOCKER_AVAILABLE=true`).
- Schema-per-test isolation: `test_<uuid>` per `runMigration()` call.
- Concurrency Lock Poller: samples `pg_locks + pg_stat_activity` every 50ms.
- Asserts `AccessExclusiveLock` hold time ≤ `--max-lock-ms` (default 500ms).
- Signal handlers: `SIGINT`, `SIGTERM`, `unhandledRejection` → container stop.
- `TESTCONTAINERS_RYUK_DISABLED=true` respected in CI.

### 3. Test Suite (480 tests, 0 failures)
- `test/reporters/github.test.ts` — 13 unit tests for GitHub reporter.
- `test/harness/testHarness.test.ts` — 16 unit tests (mock-based, no Docker required).

---

## ✅ v1.1.0: Distributed Coordination & Real-Time Topology (COMPLETED)

### 1. Distributed Advisory Lock Clustering (`src/cluster/advisory.ts`)
- Deterministic 64-bit BigInt key derivation via Node crypto SHA-256 slice (`readBigInt64BE(0)` on `ddlforge\0v1\0<project>\0<namespace>`).
- Transaction-scoped locking (`pg_try_advisory_xact_lock`) for PgBouncer/Supavisor transaction pooling safety.
- Session-scoped locking fallback (`pg_try_advisory_lock` / `pg_advisory_unlock`) for multi-transaction and autocommit flows.
- Non-blocking polling loops with timeout and distributed state table heartbeat (`ddlforge_run`).
- CLI subcommands: `ddlforge lock status` and `ddlforge lock release`.

### 2. Live Schema Drift Detection & Reverse-Engineering (`ddlforge diff`)
- High-speed, non-locking catalog queries against `pg_catalog` directly (bypassing `information_schema`) run under `REPEATABLE READ READ ONLY` with `lock_timeout = '250ms'` and `statement_timeout = '30s'`.
- Decompiles tables & columns (`format_type`, `attnotnull`, `attidentity`, `pg_get_expr`), indexes (`pg_get_indexdef`, partial predicates, `indisvalid`), constraints (`convalidated` state), partitions (`pg_inherits` recursive CTE), and enums (`enumsortorder`).
- Defensive query safety: active lock contention monitor querying `pg_stat_activity` and `pg_blocking_pids()` with self-cancellation (`pg_cancel_backend`) if blocking OLTP transactions.
- Deterministic AST schema comparator (`src/diff/comparator.ts`) with normalized `SchemaGraph` comparison.
- Risk classification: `missing`, `extra` (orphaned), `changed`, and `unsafe` (blocking locks, table rewrites, unvalidated constraints).
- CLI command: `ddlforge diff [--db <url>] [--dir <path>] [--format terminal|json]`.

### 3. Test Suite (524 tests, 0 failures)
- `test/cluster/advisory.test.ts`: BigInt boundaries, two's complement, lock manager acquisition, heartbeat, status reporting, stale lock cleanup.
- `test/diff/comparator.test.ts`: AST SchemaGraph parsing, schema drift comparisons, risk classifications, formatting.
- `test/diff/catalog.test.ts`: Direct pg_catalog snapshotting, transaction isolation, lock contention self-cancellation.
- `test/diff/cli.test.ts`: CLI help screens and argument validation.

---

## ✅ v1.2.0: Native In-Flight Data Masking & PII Anonymization (COMPLETED)

### 1. In-Flight Trigger Masking (`src/masking/triggers.ts`)
- Low-latency `BEFORE INSERT OR UPDATE` shadow column transformations (~0.05ms/row overhead) mutating `NEW` records in-memory without secondary `UPDATE`s.
- Cryptographic deterministic tokenization via salted `HMAC-SHA256` (`_ddlforge_hmac_token`) with domain isolation tags (`domain || '|' || input`).
- 16-round balanced Feistel integer cipher (`feistel_encrypt_integer`) in PL/pgSQL for microsecond sequential ID anonymization without collisions.
- Deterministic email masking (`_ddlforge_mask_email`) and format-preserving UUID v5 masking (`_ddlforge_mask_uuid`).
- Hardened function security: `SECURITY DEFINER SET search_path = pg_catalog, pg_temp` and recursion guard `WHEN (pg_trigger_depth() < 2)`.
- CLI command: `ddlforge mask trigger --table <table> --columns <col1:type,col2:type>`.

### 2. Keyset Backfill Anonymization (`src/masking/backfill.ts`)
- Resumable keyset-paginated backfill procedure (`LIMIT 2500 FOR UPDATE SKIP LOCKED`) with watermark advancement (`WHERE id > v_last_id`).
- Loop `COMMIT` statements to flush WAL increments and release row locks.
- Bounded `SET LOCAL lock_timeout = '2s'` with exponential backoff on `lock_not_available`.
- Handling cyclic dependencies and foreign key integrity via `SET CONSTRAINTS ALL DEFERRED`.
- CLI command: `ddlforge mask backfill --table <table> --columns <col1:type,col2:type> --pk <id>`.

### 3. Security & Storage Advisory Reporter (`src/masking/advisor.ts`)
- Storage optimization: automated recommendation of `fillfactor = 85` to maximize Heap-Only Tuple (HOT) updates and prevent WAL amplification.
- Secret management & catalog leakage hardening: dynamic GUC injection via `SET LOCAL app.masking_salt = ...` avoiding `pg_proc.prosrc` plaintext catalog exposure.
- Telemetry shielding: advising `pg_stat_statements.track_utility = off` to suppress secret leaks in query logs.
- Referential integrity verification queries checking for orphaned foreign keys post-backfill.
- CLI command: `ddlforge mask advice --table <table> [--format terminal|json]`.

### 4. Test Suite (553 tests, 0 failures)
- `test/masking/triggers.test.ts`: Unit tests for HMAC tokenization, 16-round Feistel cipher, BEFORE ROW triggers, security definer guards, teardown SQL.
- `test/masking/backfill.test.ts`: Keyset pagination, SKIP LOCKED, lock timeout backoff, loop commits, constraint deferral.
- `test/masking/advisor.test.ts`: Fillfactor HOT update recommendations, telemetry shielding, referential integrity verification queries, formatters.
- `test/masking/cli.test.ts`: CLI unit tests for trigger, backfill, advice subcommands and input validation.

---

## ✅ v1.3.0: Autonomous Lock Pre-emption, DDL Circuit Breaking & Deadlock Visualizer (COMPLETED)

### 1. Autonomous DDL Circuit Breaker (`src/cluster/circuitBreaker.ts`)
- **Dual-Connection Sniffer & Executor Architecture**: Executes migration DDL on an isolated executor backend while a secondary sniffer backend continuously polls `pg_stat_activity` and `pg_blocking_pids()` every 50ms.
- **Pre-emptive Lock Cancellation**: If the DDL causes > `maxQueueDepth` (default: 5) blocked queries or wait time exceeds `maxQueueWaitMs` (default: 200ms), the sniffer immediately issues `SELECT pg_cancel_backend(executorPid)` (SIGINT / SQLSTATE 57014), releasing locks and yielding immediately to OLTP transactions without severing connections.
- **Decorrelated Jitter Backoff Loop**: Catches SQLSTATE `55P03` (`lock_not_available`) and `57014` (`query_canceled`), calculating non-deterministic backoff delays via `calculateDecorrelatedJitter(baseMs, capMs, prevSleepMs)` bounded strictly within `[baseMs, capMs]` to eliminate lock convoys across poolers (PgBouncer).
- CLI command: `ddlforge run <file.sql> --db <url> [--max-queue <n>] [--max-wait-ms <n>] [--retries <n>] [--base-delay-ms <n>] [--cap-delay-ms <n>]`.

### 2. Live Lock Contention & Deadlock Visualizer (`src/cluster/deadlockGraph.ts`)
- **Real-Time Graph Traversal**: Queries `pg_stat_activity` and `pg_locks` to construct a directed wait-for graph (`waiterPid ──> blockerPid`).
- **DFS Cycle Detection**: Depth-first search with path tracking detects circular wait cycles, correctly classifying states as `DEADLOCK_CYCLE` (SQLSTATE 40P01), `LINEAR_LOCK_CHAIN`, or `CLEAN`.
- **Root Blocker Identification**: Computes PIDs with incoming wait edges but 0 outgoing wait edges (holding locks without being blocked), providing precise `pg_cancel_backend(rootPid)` remediation commands.
- **Rich Terminal & JSON Formatters**: Colorized terminal output with badges (`[ROOT BLOCKER]`, `[HOLDER]`, `[WAITING]`) and structured JSON output for observability pipelines.
- CLI command: `ddlforge top --db <url> [--watch] [--format terminal|json]`.

### 3. Test Suite (589 tests, 0 failures)
- `test/cluster/circuitBreaker.test.ts`: Decorrelated jitter bounds verification across 500 iterations, non-deterministic variation, error classification (55P03, 57014, text indicators), event emission (`tripped`, `retry`, `success`), mock pool lifecycle.
- `test/cluster/deadlockGraph.test.ts`: 2-node reciprocal cycle, 3-node circular wait, linear wait chain, clean graph, root blocker calculation, terminal and JSON formatters.
- `test/cluster/cli.test.ts`: CLI help flags, missing argument error reporting, environment variable fallbacks, and dispatch routing for `ddlforge run` and `ddlforge top`.

---

## ✅ v1.4.0: Declarative Partition Lifecycle, Online Conversion & Safe Attachment (COMPLETED)

### 1. Online Monolithic Table Conversion Generator (`src/partition/convert.ts`)
- **4-Phase Zero-Downtime Pipeline**:
  - **Phase 1 (Expand)**: Creates shadow partitioned table (`<table_name>_parted`) with matching schema defaults, constraints, and catch-all default partition to safely handle out-of-range writes during conversion.
  - **Phase 2 (Scaffolding)**: Creates updatable view abstraction (`<table_name>_view`) and bidirectional triggers (`trg_route_to_parted` and `trg_route_to_legacy`) guarded by `pg_trigger_depth() > 1`.
  - **Phase 3 (Backfill)**: Generates crash-safe keyset-paginated stored procedure (`WHERE id > v_last_id ORDER BY id ASC LIMIT batch_size FOR UPDATE SKIP LOCKED ON CONFLICT DO NOTHING`) with loop commits and jittered sleep throttling (`pg_sleep`).
  - **Phase 4 (Contract & Cutover)**: Sub-millisecond atomic rename swap on `pg_class.relname` under `SET LOCAL lock_timeout = '2s'` protection.
- CLI command: `ddlforge partition convert --table <table> --key <column> [--type range|list] [--pk <id>] [--batch-size <n>] [--throttle-ms <n>]`.

### 2. Scan-Skipping Partition Attacher (`src/partition/attach.ts`)
- **3-Phase Lock-Safe Attachment**:
  - **Phase 1 (Instantaneous Constraint)**: Adds boundary CHECK constraint matching partition bounds with `NOT VALID` (`convalidated = false`, sub-millisecond lock).
  - **Phase 2 (Concurrent Validation)**: Validates constraint under `ShareUpdateExclusiveLock` without blocking concurrent OLTP reads or writes.
  - **Phase 3 (Fast Attach & Redundant Cleanup)**: PostgreSQL recognizes `convalidated = true` and skips table sequential scan, taking an `AccessExclusiveLock` only for metadata update, followed by dropping the redundant check constraint.
- CLI command: `ddlforge partition attach --parent <tbl> --partition <part> --from <val> --to <val> [--key <col>]`.

### 3. Concurrent Partition Detacher & Retention Procedure (`src/partition/detach.ts` & `src/partition/maintenance.ts`)
- **Concurrent Detachment**: Emits autocommit-safe `ALTER TABLE ... DETACH PARTITION ... CONCURRENTLY` (PG14+) avoiding heavy parent table exclusive locks.
- **FK Trigger Anomaly Remediation**: Automates catalog inspection and validation on detached partitions to fix PG14-PG16 sub-FK detachment anomalies.
- **Automated Rolling Maintenance Procedure**: Generates autonomous stored procedures pre-allocating forward partitions (`premake` buffer) and pruning expired partitions beyond `retention` window under bounded `SET LOCAL lock_timeout = '2s'` protection.
- CLI commands:
  - `ddlforge partition detach --parent <tbl> --partition <part> [--concurrent]`
  - `ddlforge partition maintenance --parent <tbl> [--interval monthly|daily] [--premake <n>] [--retention <n>]`

### 4. Test Suite
- `test/partition/convert.test.ts`: 4-phase conversion generation, list/range strategies, view abstractions, keyset pagination, and input validation.
- `test/partition/attach.test.ts`: Scan-skipping 3-phase execution, bound literal formatting, quote escaping, and validation errors.
- `test/partition/detach.test.ts`: Concurrent autocommit detachment, non-concurrent transaction blocks, and FK anomaly remediation.
- `test/partition/maintenance.test.ts`: Daily/monthly forward pre-allocation, retention detachment loops, and lock timeout protections.
- `test/partition/cli.test.ts`: CLI help flags, subcommand routing, and missing argument validation for convert, attach, detach, maintenance.

---

## ✅ v1.5.0: Pre-flight Blast Radius, Disk Capacity, and WAL Forecasting Engine (COMPLETED)

### 1. Disk & Mount Guard Engine (`src/preflight/diskGuard.ts`)
- **Storage & Mount Topology**: Proactively inspects `pg_tablespace` and `pg_settings` for `data_directory` and `pg_wal` to detect shared-mount anti-patterns where sudden WAL volume surges can exhaust filesystem block space and cause database write freezes.
- **Mathematical Footprint Estimation**:
  - `CREATE INDEX CONCURRENTLY`: 1.5x-2x index size factoring in `maintenance_work_mem` spills to `pgsql_tmp` and safe tuple ceilings (`max(reltuples, n_live_tup + n_dead_tup)`).
  - Table Rewrites: 2x heap + TOAST size validation, rebuilt index sizes, and WAL generation stream estimates.
- **OS Disk Headroom Assertion**: Validates available disk space against safety multiplier bounds and asserts that projected remaining space does not breach the critical 15% system threshold.
- CLI command: `ddlforge preflight <file.sql> [--db <url>] [--target-table <tbl>] [--operation create_index|table_rewrite] [--available-bytes <n>]`.

### 2. Replication Lag & WAL Throttler (`src/preflight/replicationGuard.ts`)
- **BigInt LSN Handling**: Native JavaScript 64-bit `BigInt` parsing of PostgreSQL hex LSN pairs (`XX/YYYYYYYY`) and `pg_wal_lsn_diff()` outputs without floating-point precision loss.
- **Dynamic Standby Throttler**: Queries `pg_stat_replication` across streaming and cascading standbys, dynamically throttling backfill operations when replay lag exceeds byte (default: 100 MB) or duration (default: 10s) thresholds to prevent standby buffer saturation.

### 3. Static Configuration Risk Auditor & Checkpoint Telemetry (`src/preflight/configAudit.ts`)
- **Hazardous Settings Rules**: Audits `pg_settings` for production anti-patterns:
  - `log_statement = 'all'`: Flagged as `CRITICAL` (excessive I/O and disk bloat during batch DDL).
  - `full_page_writes = off`: Flagged as `CRITICAL` (unrecoverable torn-page corruption risk).
  - `statement_timeout = 0`: Flagged as `HIGH` (unbounded migration lock holding).
  - `lock_timeout = 0`: Flagged as `HIGH` (unbounded lock queue convoys).
  - `autovacuum = off`: Flagged as `HIGH` (dead tuple bloat and wraparound risk).
  - `maintenance_work_mem < 64MB`: Flagged as `MEDIUM` (forced external sort spills).
- **Version-Aware Checkpoint Telemetry**: Dynamically routes checkpoint pressure monitoring between `pg_stat_bgwriter` (PostgreSQL <= 16) and `pg_stat_checkpointer` (PostgreSQL >= 17) to calculate forced checkpoint ratios (`checkpoints_req` / `num_requested`) and detect undersized `max_wal_size`.

### 4. Test Suite
- `test/preflight/diskGuard.test.ts`: Unit tests for index footprint estimation, memory spill detection, table rewrite 2x heap + TOAST formulas, shared mount analysis, and disk headroom checks.
- `test/preflight/replicationGuard.test.ts`: Unit tests for 64-bit BigInt LSN parsing, diff calculation, standby lag evaluation, and dynamic backoff throttle delays.
- `test/preflight/configAudit.test.ts`: Unit tests for hazardous configuration rules, version-aware checkpoint telemetry routing (PG 16 vs PG 17), and forced checkpoint pressure ratings.
- `test/preflight/cli.test.ts`: CLI help flags, argument parsing, simulation mode, and database introspection workflows.

---

## ✅ v1.6.0: Disaster Recovery Readiness, Continuous WAL Archival Health, and Backup Verification Engine (COMPLETED)

### 1. Continuous WAL Archiving & Slot Health Guard (`src/recovery/pitrGuard.ts`)
- **Archiver State Machine**: Direct inspection of `pg_stat_archiver` classifying continuous WAL archival health across five deterministic states:
  - `HEALTHY`: Recent successful archives with zero failed runs.
  - `RECOVERED`: Successful archives completed following past failures.
  - `FAILING_NOW`: Active `archive_command` failures occurring within the last 1 hour or since the latest successful archive.
  - `STALE_ARCHIVE`: No successful archives within the staleness interval (default: 15 minutes).
  - `NEVER_ARCHIVED`: Unconfigured or non-functional continuous archiving.
- **Replication Slot Bloat Detection**: Inspects `pg_replication_slots` to identify inactive slots and dangerous `wal_status` values (`extended`, `unreserved`, `lost`) pinning WAL segments and risking out-of-disk server panics.
- **LSN Distance Evaluation**: Computes real-time byte distance between primary WAL write position and standby replay locations via 64-bit BigInt arithmetic (`calculateLsnDiff`).
- **CLI Command**: `ddlforge doctor [--db <url>] [--stale-minutes <n>] [--max-lag-mb <n>] [--format terminal|json]`.

### 2. Backup Recency Auditor & RPO Compliance Engine (`src/recovery/backupAuditor.ts`)
- **Multi-Provider Verification Engine**:
  - `catalog`: Inspects `ddlforge.backup_catalog` for latest completed physical or logical backups.
  - `pgbackrest`: Parses `pgbackrest info --output=json` manifests, extracting backup stop timestamps, sizes, and LSN boundaries across full, diff, and incr backups while filtering errored runs.
  - `mock` / `manual`: Deterministic simulation provider for testing and automated pipelines.
- **RPO Threshold Enforcement**: Automatically evaluates backup age against Recovery Point Objective constraints (default: 24h), raising `RpoViolationError` on non-compliant backups.
- **High-Risk Operation Interception**: Automatically detects destructive DDL statements (`DROP TABLE`, `DROP COLUMN`, `ALTER TABLE ... TYPE`, `DETACH PARTITION`, `TRUNCATE`) and aborts execution when RPO is breached or archiver is `FAILING_NOW`, unless explicitly overridden via `--force-no-backup`.

### 3. Restore Verification Hook & Target Instance Health Engine (`src/recovery/verifyRestore.ts`)
- **Post-Restoration Instance Validation**:
  - **Recovery Completion**: Asserts `pg_is_in_recovery() = false` to guarantee that restore WAL replay has completed and the instance is read-write.
  - **B-Tree Index Integrity (`amcheck`)**: Discovers all user B-Tree relations and executes `bt_index_check(oid, true)` to catch structural corruption before cutover.
  - **Referential Integrity Audit**: Queries `pg_constraint` for unvalidated foreign keys (`convalidated = false`) left over from fast restoration or unfinished migrations.
- **CLI Command**: `ddlforge verify-backup [--target-url <url>] [--rpo-hours <n>] [--skip-amcheck] [--format terminal|json]`.

### 4. Migration Safety Ledger (`src/recovery/safetyLedger.ts`)
- Persistent audit ledger recorded in `ddlforge.migration_safety_log`.
- Tracks all doctor inspections, restore verification runs, and pre-flight migration safety gates with execution timestamps, target identifiers, status badges, and structured JSON diagnostics.

### 5. Pre-flight & Circuit Breaker Integration
- Wires `pitrGuard` and `backupAuditor` checks directly into `ddlforge preflight` and `ddlforge run`.
- Halts destructive migrations before locks are acquired if continuous archiving is failing or backup RPO is violated.

### 6. Test Suite (716 tests, 0 failures)
- `test/recovery/pitrGuard.test.ts`: Unit tests for archiver health status classification across all 5 states, replication slot danger detection, and LSN distance evaluation.
- `test/recovery/backupAuditor.test.ts`: Unit tests for `pgbackrest` JSON manifest parser, catalog backup recording and queries, RPO calculation, and high-risk operation detection.
- `test/recovery/verifyRestore.test.ts`: Unit tests for recovery completion assertion, amcheck B-Tree integrity verification, unvalidated foreign keys, and safety ledger recording.
- `test/recovery/cli.test.ts`: Unit tests for `ddlforge doctor`, `ddlforge verify-backup`, and CLI help screens and options.

---

## ✅ v1.7.0: Zero-Downtime Table Compaction, In-Place Defragmentation, and Statistical Bloat Estimator (COMPLETED)

### 1. Statistical Bloat Estimator Engine (`src/compaction/bloatEstimator.ts`)
- **Zero-SeqScan Tuple Math**: Calculates table and B-Tree index bloat without sequential scans using `pg_stats`, `pg_class`, and explicit tuple layout math:
  - 24-byte page header
  - 4-byte `ItemIdData` line pointers
  - 23-byte `HeapTupleHeaderData` padded to 24-byte `MAXALIGN = 8` on 64-bit architecture
  - Dynamic null bitmap padding: `ceil(nullable_columns / 8)` bytes
  - B-Tree leaf page capacity with 24-byte header, 16-byte special space, and 10% non-leaf btree overhead
- **Heuristic Decision Matrix**:
  - Index bloat > 30% and table bloat < 10%: recommends `ddlforge compact index` (rebuilds indexes concurrently without heap rewrites).
  - Table bloat >= 25%: recommends `ddlforge compact table` (online repack).
  - Table bloat 10-25%: flags as normal MVCC churn; recommends tuning fillfactor (e.g. 85 for HOT updates).
  - Bloat < 10%: reports relation density as optimal.
- **CLI Command**: `ddlforge compact estimate [--db <url>] [--table <table>] [--threshold <pct>] [--format terminal|json]`.

### 2. Online Table Repack SQL Generator (`src/compaction/repack.ts`)
- **5-Phase Zero-Downtime Pipeline**:
  - **Phase 1 (Shadow Setup)**: Creates `<tbl>_repack_shadow` matching source schema, constraints, defaults, and indexes (`INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES`) with optional custom `TABLESPACE` and `fillfactor`.
  - **Phase 2 (Audit Change-Log Trigger)**: Creates `<tbl>_repack_log` and PL/pgSQL trigger capturing in-flight DML (`INSERT`, `UPDATE`, `DELETE`) with `pg_trigger_depth() < 2` guard preventing cascading loops.
  - **Phase 3 (Keyset Snapshot Bulk Copy)**: Creates stored procedure `sp_repack_bulk_copy_<tbl>` with keyset pagination (`WHERE id > v_last_id ORDER BY id ASC LIMIT p_batch_size FOR UPDATE SKIP LOCKED ON CONFLICT (id) DO NOTHING`), per-batch `COMMIT;`, and jittered sleep throttling (`pg_sleep(v_throttle_sec * (0.8 + (random() * 0.4)))`).
  - **Phase 4 (Catch-up Replay Loop)**: Creates stored procedure `sp_repack_replay_log_<tbl>` replay procedure hydrating payloads via `jsonb_populate_record(NULL::<shadow>, rec.payload)` and applying deletes/updates.
  - **Phase 5 (Bounded Cutover Atomic Swap)**: Dedicated cutover transaction with `SET LOCAL lock_timeout = '250ms'` and `SET LOCAL statement_timeout = '5s'`: acquires `ACCESS EXCLUSIVE` lock on target table, drains final delta, validates row count parity (`src_count == shadow_count`), tears down triggers and procedures, and executes sub-millisecond atomic rename (`orders -> orders_legacy`, `orders_repack_shadow -> orders`).
- **Advisory Lock Coordination**: Derives deterministic 64-bit cluster advisory lock via `generateAdvisoryKey('repack', '<schema>:<table>')`.
- **CLI Command**: `ddlforge compact table --table <table> [--pk <id>] [--batch-size <n>] [--throttle-ms <n>] [--lock-timeout <t>] [--fillfactor <n>] [--format terminal|json]`.

### 3. Lock-Safe Concurrent Index Reindexer (`src/compaction/reindex.ts`)
- Generates autocommit-safe `REINDEX INDEX CONCURRENTLY` and `REINDEX TABLE CONCURRENTLY` statements.
- Acquires `ShareUpdateExclusiveLock`, permitting concurrent reads, inserts, updates, and deletes.
- Transaction context validator (`validateReindexTransactionContext`) rejects execution inside explicit transaction blocks to prevent PostgreSQL SQLSTATE 55000.
- **CLI Command**: `ddlforge compact index --table <table> [--index <name>] [--schema <name>]`.

### 4. Test Suite
- `test/compaction/bloatEstimator.test.ts`: Unit tests for tuple header sizing across nullable column counts (0, 1-8, 9-16, 17-24, 25-32 cols), table bloat estimation, index bloat estimation, heuristic decision matrix, live catalog query mocking, and terminal formatting.
- `test/compaction/repack.test.ts`: Unit tests for 5-phase SQL generator, keyset bulk copy procedure, JSONB replay rehydration, trigger depth guard, bounded cutover timeouts, and parity check assertions.
- `test/compaction/reindex.test.ts`: Unit tests for concurrent index reindex syntax, table reindex syntax, and autocommit transaction context validation.
- `test/compaction/cli.test.ts`: Unit tests for `ddlforge compact` CLI routing, `estimate`, `table`, and `index` subcommands, help screens, error handling, and JSON output formatting.

---

## ✅ v1.8.0: Multi-Tenant Schema Distribution, Distributed DDL State Machine, and Cross-Tenant Schema Drift Auditing (COMPLETED)

### 1. Multi-Tenant Topology Router & Discovery (`src/distributed/tenantRouter.ts`)
- **Dual Multi-Tenant Strategies**:
  - `schema-per-tenant`: Discovers isolated namespaces via `pg_namespace` filtered with glob patterns (`--pattern <glob>`, e.g. `tenant_*`), skipping internal system namespaces (`pg_*`, `information_schema`, `ddlforge`).
  - `database-per-tenant`: Discovers physical database targets via JSON configuration files (`--config <path>`) or programmatic in-memory connection maps.
- **Glob Matching**: Deterministic translation of glob expressions (`*`, `?`) to regex with safe character escaping.
- **CLI Subcommand**: `ddlforge tenant migrate --strategy <schema|database> [options]`.

### 2. High-Throughput Worker Pool (`src/distributed/workerPool.ts`)
- **Bounded Concurrency Orchestrator**: Executes distributed migration tasks across tenant fleets with configurable concurrency limit (default: 8).
- **Pacing & Rate Limiting**: Enforces rate limiting (`--rate-limit <n>` ops/sec) and throttling delays (`--throttle-ms <n>`) to eliminate catalog lock convoys and sinval buffer saturation.
- **Failure Boundary Isolation**: Isolates individual tenant errors (`status: 'FAILED'`), preserving fleet progress unless explicit `--stop-on-error` is specified (`status: 'SKIPPED'`).
- **Comprehensive Telemetry**: Real-time progress updates and formatted execution summaries displaying tenant name, strategy, duration, status, and error details.

### 3. Distributed DDL Coordinator & State Ledger (`src/distributed/twoPhaseCoordinator.ts`)
- **Engine Invariant**: Overcomes PostgreSQL's native restriction on DDL inside `PREPARE TRANSACTION` (SQLSTATE 0A000) and autocommit requirements for concurrent DDL by implementing an application-level Distributed Transaction Coordinator.
- **Durable State Ledger**: Manages `ddlforge.ddlforge_distributed_run` tracking `(run_id, migration_version, node_id, phase, prepared_at, committed_at, gid, ddl_statement, checksum, retry_count, last_error)`.
- **State Machine**: Transitions from `PREPARED` (with normalized SHA-256 SQL checksum) to `COMMITTED`, `ABORTED`, or `HEALED`.
- **Self-Healing Orphan Sweeper**: Queries stale `PREPARED` runs older than `--max-age-minutes` (default: 30m). Automatically heals nodes (`HEALED`) if fleet majority consensus succeeded, or aborts (`ABORTED`) if consensus failed.
- **CLI Subcommand**: `ddlforge tenant sweep [--max-age-minutes <n>] [--auto-heal] [--dry-run]`.

### 4. Cross-Tenant Schema Drift Auditor (`src/distributed/driftAuditor.ts`)
- **Deterministic Schema Fingerprinting**: Computes canonical SHA-256 fingerprint from normalized catalog definitions (columns, format_type, constraints via `pg_get_expr`, and normalized index definitions).
- **Consensus Golden Schema Identification**: Automatically identifies reference schema via majority consensus (or explicit `--golden <tenant>`), grouping fleets into fingerprint clusters.
- **Drifted Snowflake Detection**: Flags non-matching tenants and calculates exact missing columns, indexes, constraints, and extra objects.
- **Zero-Downtime Reconciliation Patching**:
  - Missing indexes: `CREATE INDEX CONCURRENTLY`
  - Missing constraints: `ALTER TABLE ... ADD CONSTRAINT ... NOT VALID` followed by `ALTER TABLE ... VALIDATE CONSTRAINT`
  - Missing columns: `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`
- **CLI Subcommand**: `ddlforge tenant audit [--strategy <schema|database>] [--pattern <glob>] [--golden <name>] [--format terminal|json]`.

### 5. Test Suite
- `test/distributed/tenantRouter.test.ts`: Unit tests for glob matching, regex generation, system schema exclusion, schema-per-tenant catalog discovery, and database-per-tenant config parsing.
- `test/distributed/workerPool.test.ts`: Unit tests for worker pool concurrency bounds, pacing, failure isolation, abort-on-error, and progress reporting.
- `test/distributed/twoPhaseCoordinator.test.ts`: Unit tests for DDL normalization, SHA-256 checksumming, state ledger transitions, consensus-based orphan healing, and sweep reporting.
- `test/distributed/driftAuditor.test.ts`: Unit tests for canonical schema fingerprint hashing, golden schema determination, diff calculation, and zero-downtime reconciliation SQL generation.
- `test/distributed/cli.test.ts`: Unit tests for `ddlforge tenant` CLI routing, `migrate`, `audit`, `sweep` subcommands, help screens, error handling, and JSON formatting.

---

## ✅ v1.9.0: Autonomous Query Telemetry, Hypothetical Index Simulation (hypopg), and Index Lifecycle Advisor (COMPLETED)

### 1. Autonomous Query Telemetry & Workload Analyzer (`src/advisor/telemetryHarvester.ts`)
- **Write Amplification vs Read Latency**: Eliminates third-party APM dependency by directly mining internal PostgreSQL catalog views:
  - `pg_stat_user_tables`: `seq_scan`, `seq_tup_read`, `idx_scan`, `idx_tup_fetch`, `n_tup_ins`, `n_tup_upd`, `n_tup_del`, `n_tup_hot_upd`.
  - `pg_stat_statements`: `queryid`, `calls`, `total_exec_time`, `mean_exec_time`, `rows`, `shared_blks_read`, `shared_blks_hit`, `temp_blks_written`.
- **Mathematical Ratios & Heuristic Engine**:
  - **Read/Write Ratio**: `(idx_tup_fetch + seq_tup_read) / (n_tup_ins + n_tup_upd + n_tup_del)`
  - **HOT Update Efficiency**: `(n_tup_hot_upd / n_tup_upd) * 100`
  - **Workload Classification**: `READ_HEAVY` (>= 10.0), `BALANCED` (3.0 - 10.0), `WRITE_LEANING` (1.0 - 3.0), `WRITE_HEAVY` (< 1.0).
  - **HOT Update Preservation Guard**: Flags tables with R/W < 1.0 (`HIGH` risk) or HOT > 80% (`MEDIUM` risk) to prevent index proliferation that causes `HEAP_UPDATE_ALL_INDEXES` cascades and write bloat.
  - **Candidate Detection**: Flags tables with >= 100 sequential scans and R/W >= 2.0 as index candidates.
- **CLI Subcommand**: `ddlforge advisor analyze [--db <url>] [--schema <name>] [--table <table>] [--limit <n>] [--format terminal|json]`.

### 2. Hypothetical Index Simulator (`src/advisor/hypoSimulator.ts`)
- **Zero-Overhead Memory Simulation via `hypopg`**:
  - Injects hypothetical indexes in session-local memory via `hypopg_create_index(indexSql)`.
  - Bypasses physical disk allocation, lock contention, and WAL generation.
  - Queries virtual index footprint via `hypopg_relation_size()`.
- **Planner Adoption & Cost Differential Analysis**:
  - Benchmarks baseline query plan via `EXPLAIN (FORMAT JSON)`.
  - Traverses hypothetical plan tree recursively (`isIndexUsedInPlan`) to verify if the PostgreSQL planner chose the virtual index.
  - Calculates cost improvement percentage: `((baselineCost - hypoCost) / baselineCost) * 100`.
  - Classifies outcome: `STRONG_RECOMMENDATION` (cost reduction >= 30%), `MARGINAL_IMPROVEMENT` (reduction > 0%), or `REJECTED_BY_PLANNER` (planner prefers seq scan or existing index).
- **Leak-Proof Session Reset**: Guarantees invocation of `SELECT hypopg_reset();` inside `finally` blocks, preventing memory leakage or subsequent plan pollution.
- **CLI Subcommand**: `ddlforge advisor simulate --query <sql> --index <create-index-sql> [--db <url>] [--format terminal|json]`.

### 3. Unused & Redundant Index Pruner (`src/advisor/pruner.ts`)
- **Prefix Subsumption Engine (`isPrefixSubsumed`)**:
  - Evaluates multi-column B-Tree index key sequences (e.g. `(a)` subsumed by `(a, b)`).
  - Matches partial index predicate expressions (`indpred`) to prevent incorrect pruning of filtered indexes.
- **Strict Safety Guards**:
  - Never prunes Primary Keys (`contype = 'p'`) or Unique constraints (`contype = 'u'`).
  - Identifies Foreign Key backing indexes (`contype = 'f'`) and flags caution (`isSafeToDrop: false`) to prevent table-level lock escalation during parent record mutations.
  - Retrieves `stats_reset` timestamp from `pg_stat_database` to guard against premature pruning on freshly reset telemetry.
- **Invalid Index Self-Healing**:
  - Queries `pg_index.indisvalid = false` to identify broken index artifacts left behind by interrupted or failed `CREATE INDEX CONCURRENTLY` runs.
- **Autocommit Safe Removal**:
  - Generates zero-downtime `DROP INDEX CONCURRENTLY IF EXISTS "<schema>"."<name>";` statements.
  - CLI `--drop` flag runs drops sequentially with `lock_timeout = '2s'` on verified safe candidates.
- **CLI Subcommand**: `ddlforge advisor prune [--db <url>] [--schema <name>] [--table <table>] [--min-size-mb <n>] [--max-scans <n>] [--drop] [--format terminal|json]`.

### 4. Test Suite
- `test/advisor/telemetryHarvester.test.ts`: Unit tests for Read/Write ratio math, HOT efficiency calculations, workload classification boundaries, indexing risk evaluation, table/query catalog telemetry parsing, and terminal formatting.
- `test/advisor/hypoSimulator.test.ts`: Unit tests for EXPLAIN JSON plan parsing, recursive plan tree search, cost delta calculation, hypopg simulation with strong recommendation / marginal / rejected planner outcomes, and guaranteed `hypopg_reset()` session cleanup in `finally` blocks.
- `test/advisor/pruner.test.ts`: Unit tests for prefix containment logic, redundant index identification, primary key / unique constraint exclusion, foreign key safety warnings, invalid index detection, live catalog query mocking, and terminal output formatting.
- `test/advisor/cli.test.ts`: Unit tests for `ddlforge advisor` routing, `analyze`, `simulate`, and `prune` subcommands, help screens, and parameter validations.


## ? v2.0.0: Zero-Data-Loss Blue/Green Migration Mesh, Logical CDC Switchover, and Bi-Directional Rollback Parachute (COMPLETED)

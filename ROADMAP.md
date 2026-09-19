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
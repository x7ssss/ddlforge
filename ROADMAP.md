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

## v1.0.0 Target: Production Hardening, CI/CD & Live Harness

### 1. Standalone Bundled GitHub Action (`action/`)
- Bundled TypeScript action compiled via `@vercel/ncc` into `action/dist/index.js`.
- Inline PR diff annotations using workflow commands (`::error file={f},line={l},col={c}::{msg}`).
- CLI flag `ddlforge check --format github` for workflow integration.
- Strict exit code evaluation: fails CI check status on `BLOCKER`, logs warnings cleanly.

### 2. Ephemeral PostgreSQL Test Harness (`ddlforge test`)
- Ephemeral PostgreSQL 17 test harness using `@testcontainers/postgresql`.
- Schema-per-test isolation strategy for sub-second test execution across multi-phase DDL.
- Concurrency Lock Poller:
  - Samples `pg_locks` and `pg_stat_activity` every 50ms during live migration runs.
  - Asserts that `AccessExclusiveLock` hold durations do not exceed specified thresholds (e.g. 500ms).
- Graceful process exit handlers (`SIGINT`, `SIGTERM`, `unhandledRejection`) with Ryuk reaper fallback.

---

## v1.1.0 Target: Distributed Coordination & Real-Time Topology

### 1. Distributed Advisory Lock Clustering (`src/cluster/advisory.ts`)
- Deterministic 64-bit BigInt key derivation via Node crypto SHA-256 slice (`readBigInt64BE(0)` on `ddlforge\0v1\0namespace`).
- Transaction-scoped locking (`pg_try_advisory_xact_lock`) for PgBouncer/Supavisor transaction pooling safety.
- Non-blocking polling loops with graceful abort and distributed state table heartbeat (`ddlforge_run`).

### 2. Live Schema Drift Detection & Reverse-Engineering (`ddlforge diff`)
- High-speed, non-locking catalog queries against `pg_catalog` (avoiding `information_schema`) run under `REPEATABLE READ READ ONLY` with `lock_timeout = '250ms'`.
- Decompiles table definitions, generated/identity columns (`pg_get_expr`), indexes (partial predicates, expressions), constraints (`convalidated` state), partitions (`pg_inherits`), and enum ordering (`enumsortorder`).
- AST structural diffing via `libpg_query` normalized graphs (`SchemaGraph`) discarding location offsets and cosmetic formatting.
- Defensive query safety: active lock contention monitor querying `pg_stat_activity` and `pg_blocking_pids()` with self-cancellation (`pg_cancel_backend`) if blocking OLTP transactions.

---

## v1.2.0 Target: Native In-Flight Data Masking & PII Anonymization

### 1. In-Flight Trigger Masking (`src/masking/triggers.ts`)
- Low-latency `BEFORE INSERT OR UPDATE` shadow column transformations (~0.05ms/row overhead).
- Cryptographic deterministic tokenization via salted `HMAC-SHA256` with domain isolation tags (`domain || '|' || input`).
- Lightweight PL/pgSQL Feistel integer ciphers for microsecond sequential ID anonymization without collisions.
- Page storage optimization: automated recommendation of `fillfactor = 80-90` to maximize Heap-Only Tuple (HOT) updates and prevent WAL amplification.

### 2. Keyset Backfill Anonymization (`src/masking/backfill.ts`)
- Integrated PII anonymization inside keyset-paginated batches (`LIMIT 2500 FOR UPDATE SKIP LOCKED`).
- Foreign key referential integrity preservation: deterministic UUID v5 derivation (`uuid_generate_v5(namespace, hmac_token)`) synchronized across parent/child tables.
- Handling cyclic dependencies during masking migrations via `SET CONSTRAINTS ALL DEFERRED`.

### 3. Secret Management & Catalog Leakage Hardening
- Ephemeral GUC injection via `SET LOCAL app.masking_salt = ...` avoiding `pg_proc.prosrc` plaintext catalog exposure.
- Telemetry shielding: suppressing sensitive data exposure in `pg_stat_statements` via `track_utility = off`.
- Hardened function isolation: attaching `SECURITY DEFINER SET search_path = pg_catalog, pg_temp` to prevent schema search-path injection.
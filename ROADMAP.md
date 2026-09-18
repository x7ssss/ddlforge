ddlforge Architecture Roadmap & Concurrency Research
v0.7.0 Target: Modern ORM Traps & Transaction Boundary Safety
1. Identity Sequence Contention & Reset Trap (identity-sequence-start-with)
Severity: BLOCKER (Data Integrity Violation & AccessExclusiveLock)

Target SQL: ALTER TABLE ... ALTER COLUMN ... ADD GENERATED ALWAYS AS IDENTITY (... START WITH 1 ...)

Hazard: ORMs (especially Drizzle) generate hardcoded sequence parameters when converting columns to IDENTITY. Statically applying START WITH 1 resets the sequence on populated tables, causing immediate UNIQUE CONSTRAINT collisions on the next INSERT.

Recipe:
Safe Recipe: Inherit current max sequence value
SET LOCAL lock_timeout = '2s';
ALTER TABLE {table} ALTER COLUMN {column} ADD GENERATED ALWAYS AS IDENTITY;
SELECT setval(pg_get_serial_sequence('{table}', '{column}'), coalesce(max({column}), 1), max({column}) IS NOT NULL) FROM {table};

2. Partition Attachment Sequential Scan Cascade (attach-partition-missing-check)
Severity: BLOCKER (ShareUpdateExclusiveLock on parent + AccessExclusiveLock on partition)

Target SQL: ALTER TABLE {parent} ATTACH PARTITION {child} FOR VALUES FROM ... TO ...

Hazard: Synchronously attaching a partition forces PostgreSQL to run a full sequential scan to validate boundaries, locking the partition and queuing transactions.

Recipe:
Phase 1: Add non-blocking boundary check constraint
ALTER TABLE {child} ADD CONSTRAINT {child}_bound_chk CHECK ({col} >= '...' AND {col} < '...') NOT VALID;
Phase 2: Validate concurrently without blocking writes
ALTER TABLE {child} VALIDATE CONSTRAINT {child}_bound_chk;
Phase 3: Instant metadata-only attach
ALTER TABLE {parent} ATTACH PARTITION {child} FOR VALUES FROM '...' TO '...';
Phase 4: Drop redundant check constraint
ALTER TABLE {child} DROP CONSTRAINT {child}_bound_chk;

3. Enum Type Rewrite Escalation (enum-recreate-table-rewrite)
Severity: BLOCKER (AccessExclusiveLock & full physical table rewrite)

Target SQL: Recreating an enum type and casting via ALTER COLUMN ... TYPE ... USING col::text::new_enum

Hazard: On tables with millions of rows, casting to a recreated enum rewrites every tuple on disk under an exclusive table lock.

Recipe: In PostgreSQL 16+, use ALTER TYPE ... RENAME VALUE. In older versions, keep deprecated enum values in catalog and enforce restrictions at the application layer.

4. Non-Transactional DDL in ORM Transaction (non-transactional-in-transaction)
Severity: BLOCKER (PostgreSQL SQLSTATE 25001: active_sql_transaction)

Target SQL: CREATE INDEX CONCURRENTLY, DROP INDEX CONCURRENTLY, REINDEX CONCURRENTLY, VACUUM, ALTER TYPE ... ADD VALUE

Hazard: PostgreSQL explicitly prohibits concurrent operations inside transaction blocks via PreventInTransactionBlock(). ORM runners (Prisma, Drizzle) wrap migrations in implicit transactions by default, causing migrations to abort immediately.

Recipe:
Prisma: Prepend -- prisma-migrate-disable-next-transaction to the first line.
Drizzle: Separate concurrent statements into a standalone execution script run with autocommit mode.

5. Multi-Statement Lock Accumulation Trap (lock-accumulation-mixed-ddl-dml)
Severity: HIGH (Cascading Lock Queue Starvation & Pool Exhaustion)

Target SQL: ALTER TABLE ... followed by UPDATE / INSERT / DELETE within the same transaction block.

Hazard: Locks acquired in a transaction are held until COMMIT. An ACCESS EXCLUSIVE lock from a fast metadata ALTER TABLE will be held for the full duration of subsequent slow data backfills, blocking all application traffic.

Recipe: Split the schema change and the backfill into separate migration phases. Run backfills in small, bounded, out-of-band transaction batches.

v0.8.0 Target: Migration Orchestration, Byte-Offset Slicing & Ledger Forging
1. AST-Based Migration Slicing (ddlforge split <file.sql>)
4-Pass Statement Traversal:

AST Node Classification (Autocommit-only vs Transactional).

Directed Acyclic Graph (DAG) dependency mapping between target relations.

Chronological grouping into Phase 1 (Transactional) and Phase 2 (Autocommit).

Byte-Offset Extraction using libpg_query stmt_location and stmt_len to preserve developer comments, parameter placeholders, and formatting intact without destructive deparsing.

Output Sequencing: Generates 0001_phase1_transaction.sql and 0001_phase2_autocommit.sql for deterministic CI/CD ordering.

2. Native ORM Ledger Forging & Checksum Synchronization
Prevent ORM redeploy crashes when migrations are executed out-of-band:
a) Prisma (_prisma_migrations):

Compute exact SHA-256 hex digest of the raw UTF-8 file contents.

Forge ledger row with UUIDv4, applied_steps_count = 1, and timestamps.
b) Drizzle ORM (drizzle.__drizzle_migrations):

Compute SHA-256 over statement-breakpoint queries using Node crypto.

Forge created_at utilizing dynamic epoch milliseconds (extract(epoch from now()) * 1000)::bigint to eliminate high-water mark merge-order skipping traps.

3. Automated In-Place Migration Remediation (ddlforge check --fix)
In-place patching of unsafe SQL files to generate non-blocking transactional recipes automatically.

v0.9.0 Target: Virtual Schema & View-Based Expand/Contract Engine
1. Dual-Schema View Routing via search_path
Overlay physical tables with version-controlled schemas containing alias views (public_v1 vs public_v2).

Allow old application nodes to read legacy column schemas while new deployments connect with SET search_path TO 'public_v2'.

2. PL/pgSQL Dual-Write Triggers
Install temporary BEFORE INSERT OR UPDATE triggers to mirror writes bidirectionally between expanded physical columns and legacy columns without locking.

3. Batched Asynchronous CTID Backfills
Zero-downtime historical backfills utilizing isolated micro-transactions:
WITH batch AS (SELECT ctid FROM table WHERE new_col IS NULL LIMIT 2000 FOR UPDATE SKIP LOCKED) UPDATE table ... WHERE ctid = batch.ctid;

Bounded locks with mandatory SET LOCAL lock_timeout = '2s' and exponential backoff.

4. Contract Phase Finalization
Automated trigger removal, legacy schema/view drops, physical column drops, and final rename operations once legacy traffic reaches zero.
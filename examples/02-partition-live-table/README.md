# Example 02: Online Partitioning of a Live 50M+ Row Table

Monolithic tables exceeding tens of gigabytes experience severe B-Tree index bloat, autovacuum worker starvation, and slow sequential scans. However, native `ALTER TABLE ... ATTACH PARTITION` or table conversion requires an exclusive lock that blocks all ongoing traffic.

## Zero-Downtime Online Partitioning Workflow

1. **Target Partition Table**: Create `events_partitioned` with range bounds by month (`02_create_partitioned_target.sql`).
2. **Dual-Write Synchronization**: Install an `AFTER INSERT OR UPDATE OR DELETE` trigger routing real-time traffic to both tables (`03_dual_write_triggers.sql`).
3. **Async Keyset Backfill**: Copy historical records using `WHERE id > last_id LIMIT 5000` with 20ms throttled pacing (`04_keyset_backfill.sql`).
4. **Atomic Cutover**: In a sub-millisecond transaction with `lock_timeout = '250ms'`, drop the trigger and rename `events_partitioned -> events` (`05_atomic_cutover.sql`).

## Running this Example

```bash
# 1. Start local Postgres
docker compose -f ../docker-compose.yml up -d

# 2. Setup initial monolithic table & seed data
psql postgresql://postgres:postgrespassword@localhost:5432/postgres -f 01_initial_monolithic_events.sql

# 3. Create partitioned table & monthly ranges
psql postgresql://postgres:postgrespassword@localhost:5432/postgres -f 02_create_partitioned_target.sql

# 4. Install dual-write trigger
psql postgresql://postgres:postgrespassword@localhost:5432/postgres -f 03_dual_write_triggers.sql

# 5. Run asynchronous keyset backfill
psql postgresql://postgres:postgrespassword@localhost:5432/postgres -f 04_keyset_backfill.sql

# 6. Atomic cutover with ddlforge bounded lock timeout
npx ddlforge apply 05_atomic_cutover.sql --db postgresql://postgres:postgrespassword@localhost:5432/postgres --lock-timeout 250ms
```

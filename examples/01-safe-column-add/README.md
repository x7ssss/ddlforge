# Example 01: Zero-Downtime Column Addition on a 10M Row Table

Adding a `NOT NULL` column with a default value directly to an active table (`ALTER TABLE users ADD COLUMN is_verified BOOLEAN NOT NULL DEFAULT true;`) requests an `ACCESS EXCLUSIVE` lock. Even if metadata-only in newer Postgres versions, acquiring `ACCESS EXCLUSIVE` waits behind active `SELECT` queries, creating an immediate queue pileup that exhausts application connection pools.

## Safe Expand / Contract Pattern

1. **Phase 1 (Expand)**: Add the column as nullable with the default (`safe_expand_phase1.sql`). Takes sub-millisecond catalog lock.
2. **Phase 2 (Async Backfill)**: Backfill historical rows in batches of 5,000 using keyset pagination (`safe_backfill_phase2.sql`).
3. **Phase 3 (Contract)**: Add a `CHECK (is_verified IS NOT NULL) NOT VALID;` constraint and validate concurrently (`safe_contract_phase3.sql`) without write locks.

## Running this Example

```bash
# 1. Start local Postgres
docker compose -f ../docker-compose.yml up -d

# 2. Setup initial schema & seed 10k rows
psql postgresql://postgres:postgrespassword@localhost:5432/postgres -f schema.sql

# 3. Test unsafe migration detection
npx ddlforge check unsafe_migration.sql

# 4. Apply safe phases sequentially
npx ddlforge apply safe_expand_phase1.sql --db postgresql://postgres:postgrespassword@localhost:5432/postgres
npx ddlforge apply safe_backfill_phase2.sql --db postgresql://postgres:postgrespassword@localhost:5432/postgres
npx ddlforge apply safe_contract_phase3.sql --db postgresql://postgres:postgrespassword@localhost:5432/postgres
```

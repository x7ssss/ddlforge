# ddlforge

> **Ultra-fast PostgreSQL migration lock linter & runtime execution supervisor.**  
> Built for Node.js 20+ and TypeScript. Designed for high-traffic Prisma, Drizzle, and raw SQL backends.

[![Node.js](https://img.shields.io/badge/Node.js-20%2B-green.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5%2B-blue.svg)](https://www.typescriptlang.org)
[![Check: Zero Dependencies](https://img.shields.io/badge/Check%20Runtime%20Deps-0-success.svg)](package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## What is ddlforge?

`ddlforge` is a two-mode PostgreSQL migration safety tool:

| Mode | Command | What it does | Dependencies |
|:-----|:--------|:-------------|:-------------|
| **Check** (lint) | `ddlforge [paths…]` | Statically analyses SQL files for lock hazards and data-loss patterns. Exits `1` on blockers. | **Zero** — pure Node.js stdlib |
| **Apply** (execute) | `ddlforge apply <file> --db <url>` | Runs migrations against a live database with per-statement lock-timeout injection, full-jitter exponential retry, and a background queue-avalanche breaker. | Requires `pg` (auto-detected at runtime) |

Both modes share the same zero-dependency SQL lexer. **Installing `pg` is only required for `apply`** — `check` always works without it.

---

## Why ddlforge?

In PostgreSQL, DDL commands take **table-level locks**. Even a millisecond-fast migration can cause a complete service outage:

1. The migration waits to acquire an `ACCESS EXCLUSIVE` lock while a long-running `SELECT` holds its own lock.
2. **Every query behind it queues up**, including basic reads.
3. Connection pools saturate within seconds, crashing all services.

`ddlforge check` catches these patterns **before code merges**. `ddlforge apply` executes migrations with production-grade safeguards so even risky DDL lands safely.

---

## Quick Start

```bash
# Lint migrations (zero dependencies required):
npx ddlforge ./prisma/migrations

# Apply a migration safely to a live database:
npx ddlforge apply ./migrations/001_add_index.sql --db "$DATABASE_URL"
```

---

## `ddlforge check` — Static Lock Linter

### Zero-Dependency Design

`ddlforge check` is built on a **pure Node.js single-pass SQL lexer** — no `pg`, no `node-postgres`, no external parsers. It runs air-gap safe in any CI environment without a database connection.

### Installation

```bash
# Global
npm install -g ddlforge

# Per-project dev dependency
npm install --save-dev ddlforge

# No install (npx)
npx ddlforge ./prisma/migrations
```

### CLI Flags

```text
ddlforge [paths...] [flags]

ARGUMENTS:
  paths               Migration files or directories (e.g. ./prisma/migrations, ./drizzle)

FLAGS:
  --pg <version>      Target PostgreSQL version (default: 16)
  --format <type>     Output format: terminal | json | markdown (default: terminal)
  --quiet, -q         Show blockers only; suppress warnings and advisories
  --changed-only      Lint only files changed in the current git branch / PR
  --version, -v       Print version and exit
  --help, -h          Print help and exit
```

### Examples

```bash
# Scan all Prisma migrations
npx ddlforge ./prisma/migrations

# Scan only files touched in this branch/PR
npx ddlforge --changed-only

# Drizzle migrations, targeting Postgres 14, JSON output for CI
npx ddlforge ./drizzle --pg 14 --format json

# Blockers-only output, non-zero exit on any blocker
npx ddlforge ./migrations --quiet
```

### Output formats

**Terminal** (default) — colorized, human-readable:
```
 BLOCKER  CREATE INDEX without CONCURRENTLY [LOCK: SHARE]
   at migrations/001.sql:1:1 (rule: require-concurrent-index)

   1 │ CREATE INDEX idx_users_email ON users(email);

   Why: Acquires a SHARE lock — blocks all INSERT, UPDATE, DELETE…
   Fix:
      CREATE INDEX CONCURRENTLY idx_users_email ON users(email);
```

**JSON** — machine-readable, CI-parseable:
```bash
npx ddlforge ./migrations --format json | jq '.summary'
```

**Markdown** — paste directly into GitHub PR comments:
```bash
npx ddlforge --changed-only --format markdown >> $GITHUB_STEP_SUMMARY
```

---

## `ddlforge apply` — Runtime Execution Supervisor

`ddlforge apply` is a production-grade DDL execution engine. Rather than running `psql` or a raw ORM migration runner, it wraps each statement in a hardened execution loop:

```
┌──────────────────── ddlforge apply ──────────────────────────────────────┐
│                                                                           │
│  Parse SQL file   →  For each statement:                                 │
│                       1. BEGIN transaction                                │
│                       2. SET LOCAL lock_timeout = '<ms>'                 │
│                       3. SET LOCAL statement_timeout = '<ms>'            │
│                       4. Execute statement                               │
│                       ├─ Success → COMMIT, next statement                │
│                       └─ Lock error (55P03 / 57014)                     │
│                            → ROLLBACK                                    │
│                            → Full-jitter backoff sleep                  │
│                            → Retry (up to --max-retries)                │
│                                                                           │
│  Background (parallel):                                                   │
│       Lock-Queue Monitor polls pg_locks every 500ms                     │
│       If blocked_backends ≥ threshold → pg_cancel_backend()             │
│       → AVALANCHE ABORT (protects connection pool)                       │
│                                                                           │
└───────────────────────────────────────────────────────────────────────────┘
```

### Prerequisites

`ddlforge apply` dynamically imports `pg` at runtime. If it's not installed you'll get clear instructions:

```bash
npm install pg          # npm
yarn add pg             # yarn
pnpm add pg             # pnpm
```

> **Note:** `ddlforge check` (static linting) **never** imports `pg`. You do not need `pg` unless you use `apply`.

### CLI Flags

```text
ddlforge apply <file.sql> --db <DATABASE_URL> [flags]

ARGUMENTS:
  <file.sql>                  SQL migration file to execute

FLAGS:
  --db <url>                  PostgreSQL connection URL (required,
                              or set DATABASE_URL env var)
  --lock-timeout <ms>         Per-statement lock_timeout (default: 3000)
  --statement-timeout <ms>    Per-statement statement_timeout (default: 30000)
  --max-retries <n>           Max retry attempts on lock timeout (default: 5)
  --dry-run                   Parse & display statements without executing
  --lock-queue-threshold <n>  Blocked-backend count that triggers cancellation
                              (default: 1)
  --monitor-poll-ms <ms>      Lock-monitor polling interval (default: 500)
  --help, -h                  Print this help and exit
```

### Examples

```bash
# Basic apply
ddlforge apply ./migrations/001_add_index.sql --db postgres://localhost/mydb

# Use DATABASE_URL env var
ddlforge apply ./migrations/001_add_index.sql --db "$DATABASE_URL"

# Dry run: parse and preview statements without touching the database
ddlforge apply ./migrations/001_add_index.sql --db "$DATABASE_URL" --dry-run

# Custom timeouts and more retries
ddlforge apply ./migrations/001_add_index.sql \
  --db "$DATABASE_URL" \
  --lock-timeout 5000 \
  --statement-timeout 60000 \
  --max-retries 8

# Conservative mode: abort as soon as even 1 backend queues behind us
ddlforge apply ./migrations/001_add_index.sql \
  --db "$DATABASE_URL" \
  --lock-queue-threshold 1

# Lenient mode: allow up to 3 backends to queue before cancelling
ddlforge apply ./migrations/001_add_index.sql \
  --db "$DATABASE_URL" \
  --lock-queue-threshold 3
```

### Live Terminal Output

```
ddlforge apply /path/to/001_add_index.sql
  lock_timeout:      3000ms
  statement_timeout: 30000ms
  max_retries:       5
  queue_threshold:   1

  [1/3] CREATE INDEX CONCURRENTLY idx_users_email ON users(email); ✔ (2847ms)
  [2/3] ALTER TABLE users ADD COLUMN bio TEXT;                      ✔ (12ms)
  [2/3] ALTER TABLE orders ADD CONSTRAINT fk_user …                ↺ retry 1 (backoff 183ms)
  [3/3] ALTER TABLE orders ADD CONSTRAINT fk_user …                ✔ (31ms)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 APPLIED  3/3 statement(s) executed successfully in 3156ms
```

---

## Safety Mechanisms Explained

### 1. Session Lock-Timeout Injection

For every statement, `ddlforge apply` injects `SET LOCAL` timeouts **inside the transaction**, ensuring they are always scoped to that statement only and automatically reset after commit/rollback:

```sql
BEGIN;
SET LOCAL lock_timeout = '3000';       -- abort if lock not acquired in 3s
SET LOCAL statement_timeout = '30000'; -- abort if statement runs > 30s
ALTER TABLE users ADD COLUMN bio TEXT;
COMMIT;
```

Using `SET LOCAL` (rather than `SET`) guarantees:
- Timeouts apply only to the current statement, not the whole session.
- Other concurrent connections are unaffected.
- A mid-migration crash automatically resets to the session default.

### 2. Full-Jitter Exponential Backoff

When a statement fails with a lock error (`55P03: lock_not_available` or `57014: query_canceled`), ddlforge does **not** retry immediately. It sleeps for a randomised interval before trying again.

**Algorithm:**
```
sleep = Math.random() × min(maxDelay, baseDelay × 2^attempt)
```

| Attempt | Base window | Actual sleep (example) |
|:-------:|:-----------:|:----------------------:|
| 1 | 500 ms | 217 ms |
| 2 | 1 000 ms | 843 ms |
| 3 | 2 000 ms | 1 341 ms |
| 4 | 4 000 ms | 2 887 ms |
| 5 | 8 000 ms | 6 104 ms |

The full-jitter pattern (rather than deterministic or additive jitter) ensures that **multiple migrations running simultaneously spread their retries apart**, preventing the "retry stampede" that would re-create the exact lock convoy they are trying to escape.

### 3. Background Lock-Queue Monitor (Avalanche Breaker)

Before executing each statement, ddlforge spawns a **background monitor** on a separate database connection. It polls `pg_locks` and `pg_stat_activity` every 500 ms:

```sql
SELECT COUNT(*) AS blocked_count
FROM  pg_locks blocker
JOIN  pg_locks waiter
     ON  waiter.relation  = blocker.relation
     AND waiter.locktype  = blocker.locktype
     AND waiter.pid      <> blocker.pid
WHERE blocker.pid    = $1          -- migration's backend PID
  AND blocker.granted = TRUE
  AND waiter.granted  = FALSE
```

If the number of waiting backends reaches `--lock-queue-threshold` (default: **1**), the monitor immediately issues:

```sql
SELECT pg_cancel_backend($1);      -- sends SIGINT to migration PID
```

This triggers a controlled rollback of the migration statement — which releases the lock — unblocking the entire queue **before connection pools saturate**. The breaker chooses `pg_cancel_backend` (not `pg_terminate_backend`) so the migration client can clean up gracefully and report the event.

After cancellation, `ddlforge apply` reports a clear **AVALANCHE ABORT** event and exits with code `1`.

**Why this matters:** A single `ALTER TABLE` holding an `ACCESS EXCLUSIVE` lock for even 5 seconds can cause thousands of queries to queue, exhausting all available connections in a busy pool within 10–30 seconds. The avalanche breaker keeps that window under your polling interval.

---

## The 7 Core Lint Rules & Zero-Downtime Recipes

### 1. `require-concurrent-index` — CREATE INDEX without CONCURRENTLY

- **Severity**: `BLOCKER`  
- **Lock**: `SHARE` — blocks all `INSERT`, `UPDATE`, `DELETE`

```sql
-- ❌ Dangerous
CREATE INDEX idx_users_email ON users(email);

-- ✅ Zero-Downtime Fix
CREATE INDEX CONCURRENTLY idx_users_email ON users(email);
```

---

### 2. `concurrent-index-in-transaction` — CONCURRENTLY inside a Transaction

- **Severity**: `BLOCKER`  
- **Engine Behavior**: PostgreSQL raises `ERROR: CREATE INDEX CONCURRENTLY cannot run inside a transaction block`.

```sql
-- ❌ Dangerous
BEGIN;
CREATE INDEX CONCURRENTLY idx_users_email ON users(email);
COMMIT;

-- ✅ Zero-Downtime Fix (Prisma)
-- prisma:no-transaction
CREATE INDEX CONCURRENTLY "users_email_idx" ON "users"("email");
```

> **Prisma Caveat:** Prisma Migrate wraps all migrations in an implicit transaction by default. Add `-- prisma:no-transaction` at the top of the migration file to disable this.

---

### 3. `add-column-not-null-without-default` — ADD COLUMN NOT NULL without DEFAULT

- **Severity**: `BLOCKER`  
- **Lock**: `ACCESS EXCLUSIVE`

```sql
-- ❌ Dangerous
ALTER TABLE users ADD COLUMN role VARCHAR(50) NOT NULL;

-- ✅ Zero-Downtime Fix (PG 11+ static default — metadata-only, instant)
ALTER TABLE users ADD COLUMN role VARCHAR(50) DEFAULT 'user' NOT NULL;
```

---

### 4. `foreign-key-missing-not-valid` — ADD CONSTRAINT FOREIGN KEY without NOT VALID

- **Severity**: `BLOCKER`  
- **Lock**: `SHARE ROW EXCLUSIVE` on referencing table + `SHARE` on referenced table

```sql
-- ❌ Dangerous
ALTER TABLE orders ADD CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id);

-- ✅ Zero-Downtime Fix (two-step)
-- Step 1: instant metadata operation, no row scan
ALTER TABLE orders ADD CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id) NOT VALID;
-- Step 2: SHARE UPDATE EXCLUSIVE only — reads & writes proceed
ALTER TABLE orders VALIDATE CONSTRAINT fk_user;
```

---

### 5. `prisma-silent-rename-data-loss` — Prisma Silent Field Rename

- **Severity**: `BLOCKER` (data-loss prevention)  
- **Effect**: `ACCESS EXCLUSIVE` lock + permanent column data deletion

```sql
-- ❌ Dangerous — Prisma generates DROP + ADD for any field rename
ALTER TABLE "users" DROP COLUMN "old_name";
ALTER TABLE "users" ADD COLUMN "new_name" TEXT NOT NULL;

-- ✅ Zero-Downtime Fix
ALTER TABLE "users" RENAME COLUMN "old_name" TO "new_name";
-- Or use @map("old_name") in schema.prisma to avoid DB column renames entirely
```

---

### 6. `set-not-null-full-scan` — ALTER COLUMN SET NOT NULL

- **Severity**: `WARNING` (PG 12+) / `BLOCKER` (PG < 12)  
- **Lock**: `ACCESS EXCLUSIVE` while scanning entire table for nulls

```sql
-- ❌ Dangerous
ALTER TABLE users ALTER COLUMN email SET NOT NULL;

-- ✅ Zero-Downtime Fix (PG 12+ — check constraint enables fast-path)
ALTER TABLE users ADD CONSTRAINT chk_email_not_null CHECK (email IS NOT NULL) NOT VALID;
ALTER TABLE users VALIDATE CONSTRAINT chk_email_not_null;
ALTER TABLE users ALTER COLUMN email SET NOT NULL;
```

---

### 7. `unbatched-dml` — Unbatched DML in Migration

- **Severity**: `BLOCKER` (no `WHERE`) / `WARNING` (with `WHERE`)  
- **Effect**: `ROW EXCLUSIVE` on all touched rows, massive WAL bloat, long-running transaction

```sql
-- ❌ Dangerous
UPDATE users SET active = true;

-- ✅ Fix: batch via background worker, or exempt a known-small table
-- ddlforge-ignore unbatched-dml
UPDATE subscription_tiers SET active = true WHERE code = 'PRO';
```

---

## GitHub Actions Workflows

### Check (lint) — Zero-Dependency CI

```yaml
name: Migration Lock Linter

on:
  pull_request:
    paths:
      - '**/migrations/**'
      - '**/*.sql'

jobs:
  lint-migrations:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Lint changed migration files
        run: npx ddlforge --changed-only --format terminal

      - name: Post migration safety report to PR
        if: always()
        run: npx ddlforge --changed-only --format markdown >> $GITHUB_STEP_SUMMARY
```

### Apply — Supervised execution in deployment pipeline

```yaml
name: Deploy Migrations

on:
  push:
    branches: [main]

jobs:
  migrate:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Install dependencies
        run: npm ci

      - name: Lint migrations before applying
        run: npx ddlforge ./migrations --format terminal

      - name: Apply migrations (supervised)
        env:
          DATABASE_URL: ${{ secrets.DATABASE_URL }}
        run: |
          npx ddlforge apply ./migrations/$(date +%Y%m%d)_*.sql \
            --db "$DATABASE_URL" \
            --lock-timeout 5000 \
            --statement-timeout 60000 \
            --max-retries 5 \
            --lock-queue-threshold 1
```

---

## PostgreSQL Lock Hierarchy Reference

| Lock Mode | Acquired By | Blocks Reads? | Blocks Writes? | Risk |
|:----------|:------------|:-------------:|:--------------:|:----:|
| `ACCESS SHARE` | `SELECT` | ❌ | ❌ | Low |
| `ROW SHARE` | `SELECT FOR UPDATE/SHARE` | ❌ | ❌ | Low |
| `ROW EXCLUSIVE` | `INSERT`, `UPDATE`, `DELETE` | ❌ | ❌ | Medium |
| `SHARE UPDATE EXCLUSIVE` | `CREATE INDEX CONCURRENTLY`, `VACUUM`, `ANALYZE` | ❌ | ❌ | ✅ Safe |
| `SHARE` | `CREATE INDEX` (non-concurrent) | ❌ | **YES** | 🛑 Blocker |
| `SHARE ROW EXCLUSIVE` | `ADD CONSTRAINT FK` (without `NOT VALID`) | ❌ | **YES** | 🛑 Blocker |
| `EXCLUSIVE` | `REFRESH MATERIALIZED VIEW CONCURRENTLY` | Partial | **YES** | 🛑 Blocker |
| `ACCESS EXCLUSIVE` | `ALTER TABLE`, `DROP TABLE`, `TRUNCATE` | **YES** | **YES** | 🚨 Critical |

---

## Inline Directives

Suppress specific rules per-statement with inline comments:

```sql
-- ddlforge-ignore require-concurrent-index
CREATE INDEX idx_temp ON temporary_cache(key);

-- ddlforge-ignore unbatched-dml
UPDATE plan_limits SET max_seats = 100 WHERE plan_id = 'enterprise';
```

Disable all rules for a statement:
```sql
-- ddlforge-ignore
ALTER TABLE legacy_table ADD COLUMN migrated_at TIMESTAMPTZ;
```

Prisma no-transaction directive (file-level):
```sql
-- prisma:no-transaction
CREATE INDEX CONCURRENTLY "users_email_idx" ON "users"("email");
```

---

## Programmatic TypeScript API

### Static analysis (check)

```typescript
import { analyzeSql, MigrationAnalyzer, formatTerminal } from 'ddlforge';

const result = analyzeSql(`
  CREATE INDEX idx_users_email ON users(email);
`, {
  filePath: 'migrations/001.sql',
  pgVersion: 16,
});

if (result.hasBlockers) {
  console.log(formatTerminal([result]));
  process.exit(1);
}
```

### Runtime execution (apply)

```typescript
import { executeMigration } from 'ddlforge/runner/executor';

const result = await executeMigration(sql, {
  databaseUrl:        process.env.DATABASE_URL!,
  lockTimeout:        '3000ms',
  statementTimeout:   '30000ms',
  maxRetries:         5,
  lockQueueThreshold: 1,
  dryRun:             false,
  onProgress(event) {
    if (event.kind === 'statement-retry') {
      console.log(`  ↺ retry ${event.attempt}, backoff ${Math.round(event.retryBackoffMs ?? 0)}ms`);
    }
    if (event.kind === 'avalanche-abort') {
      console.error(`  ⚠ AVALANCHE ABORT: ${event.error}`);
    }
  },
});

if (!result.success) {
  console.error(`Migration failed: ${result.error}`);
  process.exit(1);
}
```

---

## Architecture

```
ddlforge/
├── src/
│   ├── lexer/
│   │   ├── sqlTokenizer.ts    # Zero-dep single-pass SQL lexer + statement splitter
│   │   └── tokens.ts          # Token & Statement type definitions
│   ├── engine/
│   │   ├── analyzer.ts        # Rule pipeline orchestrator
│   │   └── locks.ts           # PostgreSQL lock level taxonomy
│   ├── rules/
│   │   ├── indexConcurrently.ts
│   │   ├── transactionTrap.ts
│   │   ├── addColumnNotNull.ts
│   │   ├── foreignKeyNotValid.ts
│   │   ├── prismaRenameDropAdd.ts
│   │   ├── setNotNullFullScan.ts
│   │   └── unbatchedBackfill.ts
│   ├── runner/                # apply — runtime supervisor (pg via dynamic import)
│   │   ├── backoff.ts         # Full-jitter exponential backoff
│   │   ├── locksMonitor.ts    # pg_locks queue-avalanche breaker
│   │   └── executor.ts        # Per-statement execution loop
│   ├── reporters/
│   │   ├── terminal.ts
│   │   ├── json.ts
│   │   └── markdown.ts
│   └── cli.ts                 # Argument parser, check + apply dispatch
└── test/
    ├── analyzer.test.ts        # 37 rule & CLI tests
    └── runner.test.ts          # 38 backoff, monitor & executor tests
```

---

## Testing

```bash
npm test
```

```text
ℹ tests 75
ℹ suites 19
ℹ pass 75
ℹ fail 0
ℹ duration_ms ~575
```

Performance benchmark:
```text
✔ analyzes 100 migrations in under 100 milliseconds (10.2ms)
```

---

## License

MIT © [x7sss](https://github.com/x7ssss)

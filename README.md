# ddlforge

> **Zero-dependency PostgreSQL DDL migration supervisor & linter for Node.js / TypeScript.**  
> Eliminates lock queues, connection pool exhaustion, and deploy deadlocks across Prisma, Drizzle, and raw SQL migrations.

[![npm version](https://img.shields.io/badge/npm-v0.5.0-blue.svg)](package.json)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-green.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5%2B-blue.svg)](https://www.typescriptlang.org)
[![Tests](https://img.shields.io/badge/Tests-132%20passing-brightgreen.svg)](test)
[![Zero Dependencies](https://img.shields.io/badge/Check%20Deps-0-success.svg)](package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Support on Ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/x7sss)

---

## Quick Start (Prisma & Drizzle)

Drop `ddlforge wrap` directly in front of your ORM migration commands:

```bash
# Supervise Prisma deployments
npx ddlforge wrap -- npx prisma migrate deploy

# Supervise Drizzle migrations
npx ddlforge wrap -- npx drizzle-kit migrate
```

### What does `wrap` do?

1. **Auto-detects migration folders**: Discovers `prisma/migrations` or `drizzle` directory layouts (or uses `--dir` override).
2. **Filters pending migrations**: Compares against database schema history tables (`_prisma_migrations` or `__drizzle_migrations` when `--db` / `DATABASE_URL` is accessible), or verifies all candidate files if `--db` is omitted.
3. **Pre-flight safety interception**: Evaluates all pending migrations with zero-downtime rules. If any `BLOCKER` hazard is detected, it outputs rich diagnostics with remediation recipes and **aborts deployment before running the child process** (exit code `1`).
4. **Execution delegation**: When pre-flight safety checks pass, it spawns your migration command with inherited stdio (`stdio: 'inherit'`) and cleanly propagates the child process's exit code.

---

## Why ddlforge?

In PostgreSQL, DDL commands take **table-level locks**. Even a sub-millisecond migration can cause a catastrophic production outage:

```
┌───────────────────────────── The Migration Lock Trap ──────────────────────────────┐
│                                                                                    │
│   1. Long SELECT holds ACCESS SHARE lock on "users"                                │
│   2. ALTER TABLE requests ACCESS EXCLUSIVE lock                                    │
│      └─ BLOCKED: Waits behind the SELECT                                           │
│   3. Subsequent web queries (SELECT, INSERT, UPDATE) arrive                        │
│      └─ BLOCKED: Queue behind the waiting ALTER TABLE!                             │
│   4. Connection pool saturates within 5–15 seconds                                 │
│      └─ Outage: All application endpoints return 504 Gateway Timeout               │
│                                                                                    │
└────────────────────────────────────────────────────────────────────────────────────┘
```

`ddlforge` eliminates this risk at every phase:
- **In CI**: `ddlforge check` fails pull requests before dangerous DDL reaches `main`.
- **In ORM deployments**: `ddlforge wrap` intercepts pending migrations and aborts before running unvalidated changes.
- **In direct execution**: `ddlforge apply` injects statement lock-timeouts, retries with full jitter, and runs a background avalanche-breaker.

---

## The 3 Core Commands

| Command | Mode | Primary Use Case | Dependencies |
|:--------|:-----|:-----------------|:-------------|
| **`ddlforge wrap`** | Interceptor | Drop-in wrapper for ORM deployments (Prisma, Drizzle) | **Zero** (pure Node.js stdlib) |
| **`ddlforge check`** | Linter | Static CI analysis & GitHub Code Scanning SARIF | **Zero** (pure Node.js stdlib) |
| **`ddlforge apply`** | Supervisor | Hardened raw SQL execution with session timeouts & retry | Requires `pg` (auto-detected) |

---

### 1. `ddlforge wrap` — Pre-flight ORM Interceptor

Supervises external migration commands by running pre-flight safety checks against pending migration files before delegating execution.

```text
ddlforge wrap [options] -- <command...>

ARGUMENTS:
  <command...>        Migration command to execute if safety checks pass

FLAGS:
  --dir <path>        Migration directory (auto-detects prisma/migrations, drizzle, or ./migrations)
  --db <url>          Database URL for pending migration comparison (falls back to DATABASE_URL)
  --allow-blockers    Warn on blockers instead of aborting the command
  --help, -h          Print wrap help and exit
```

#### Examples

```bash
# Supervise standard Prisma deployment
npx ddlforge wrap -- npx prisma migrate deploy

# Supervise Drizzle deployment with explicit directory
npx ddlforge wrap --dir=./drizzle -- npx drizzle-kit migrate

# Allow blockers in emergency deploys (warns without aborting)
npx ddlforge wrap --allow-blockers -- npx prisma migrate deploy
```

---

### 2. `ddlforge check` — Fast AST Linter for CI

Statically parses SQL files with a zero-dependency, single-pass lexer and AST analyzer. Emits human-readable terminal output, JSON, GitHub Markdown, or SARIF 2.1.0.

```text
ddlforge check [paths...] [flags]

ARGUMENTS:
  paths               Migration files or directories (e.g. ./prisma/migrations, ./drizzle)

FLAGS:
  --format <type>     Output format: pretty | terminal | json | markdown | sarif (default: pretty)
  --output <path>     Write report directly to a file (ideal for SARIF or Markdown step summaries)
  --pg <version>      Target PostgreSQL version (default: 16)
  --quiet, -q         Show blockers only; suppress warnings and advisories
  --changed-only      Use git diff to lint only files modified in this branch / PR
  --version, -v       Print ddlforge version and exit
  --help, -h          Print check help and exit
```

#### Examples

```bash
# Scan Prisma migrations directory
npx ddlforge check ./prisma/migrations

# Lint only changed files in current PR
npx ddlforge check --changed-only

# Generate SARIF 2.1.0 report for GitHub Code Scanning
npx ddlforge check "prisma/migrations/**/*.sql" --format=sarif --output=ddlforge.sarif

# Export JSON summary for custom CI tooling
npx ddlforge check ./drizzle --format=json --output=report.json
```

---

### 3. `ddlforge apply` — Supervised Raw SQL Execution Runner

Executes raw SQL migration files against live databases with automated safeguards:
- **Per-statement timeout injection**: Automatically injects session `lock_timeout` and `statement_timeout`.
- **Non-transactional `CONCURRENTLY` splitting**: Automatically detects statements forbidden inside transactions (`CREATE/DROP INDEX CONCURRENTLY`, `REINDEX CONCURRENTLY`, `VACUUM`) and runs them outside `BEGIN...COMMIT` with session-level `SET` / `RESET` timeouts.
- **Exponential backoff with full jitter**: Randomizes retry intervals on lock errors (`55P03` / `57014`) to prevent retry stampedes.
- **Background lock-queue monitor**: Continuously polls `pg_locks` on an isolated connection and executes `pg_cancel_backend` if queue depth reaches threshold.

```text
ddlforge apply <file.sql> --db <DATABASE_URL> [flags]

ARGUMENTS:
  <file.sql>                  SQL migration file to execute

FLAGS:
  --db <url>                  PostgreSQL connection URL (required, or set DATABASE_URL)
  --lock-timeout <ms>         Per-statement lock_timeout in ms (default: 3000ms)
  --statement-timeout <ms>    Per-statement statement_timeout in ms (default: 30000ms)
  --max-retries <n>           Max retry attempts on lock timeout (default: 5)
  --dry-run                   Parse and display statements without executing
  --lock-queue-threshold <n>  Blocked queries behind migration before aborting (default: 1)
  --monitor-poll-ms <ms>      Lock-monitor polling interval in ms (default: 500)
  --help, -h                  Print apply help and exit
```

#### Example

```bash
npx ddlforge apply ./migrations/001_add_index.sql \
  --db "$DATABASE_URL" \
  --lock-timeout 2500 \
  --statement-timeout 60000 \
  --max-retries 5 \
  --lock-queue-threshold 1
```

---

## Complete Rule Catalog & Zero-Downtime Recipes

| Rule ID | Lock Level | Severity | Trigger / Hazard | Zero-Downtime Recipe |
|:--------|:-----------|:--------:|:-----------------|:---------------------|
| `require-concurrent-index`<br>`(index-concurrently)` | `SHARE` | **BLOCKER** | `CREATE INDEX` without `CONCURRENTLY` blocks all table writes (`INSERT`, `UPDATE`, `DELETE`). | Add `CONCURRENTLY` keyword: `CREATE INDEX CONCURRENTLY idx ON table(col);` |
| `concurrent-index-in-transaction`<br>`(transaction-trap)` | `NONE` | **BLOCKER** | PostgreSQL prohibits `CONCURRENTLY` inside transaction blocks (`BEGIN...COMMIT` or Prisma default). | Run outside transaction, or add `-- prisma:no-transaction` directive. |
| `add-column-not-null-without-default`<br>`(add-column-not-null)` | `ACCESS EXCLUSIVE` | **BLOCKER** | `ADD COLUMN ... NOT NULL` without `DEFAULT` triggers table scan and fails on populated tables. | Provide static `DEFAULT` (instant in PG 11+) or add nullable, backfill, and validate. |
| `foreign-key-missing-not-valid`<br>`(foreign-key-not-valid)` | `SHARE ROW EXCLUSIVE` | **BLOCKER** | Inline `FOREIGN KEY` addition holds write locks on both parent and child tables during validation. | 1. `ADD CONSTRAINT fk ... NOT VALID;`<br>2. `VALIDATE CONSTRAINT fk;` |
| `check-constraint-not-valid`<br>`(check-constraint-not-valid)` | `ACCESS EXCLUSIVE` | **BLOCKER** | Adding `CHECK (...)` without `NOT VALID` blocks all reads & writes during entire table scan. | 1. `ADD CONSTRAINT chk CHECK (...) NOT VALID;`<br>2. `VALIDATE CONSTRAINT chk;` |
| `unique-constraint-using-index`<br>`(unique-constraint-using-index)` | `SHARE` | **BLOCKER** | `ADD CONSTRAINT ... UNIQUE (cols)` directly locks writes while creating the unique index. | 1. `CREATE UNIQUE INDEX CONCURRENTLY idx ON t(cols);`<br>2. `ADD CONSTRAINT uq UNIQUE USING INDEX idx;` |
| `prisma-silent-rename-data-loss`<br>`(prisma-rename-drop-add)` | `ACCESS EXCLUSIVE` | **BLOCKER** | Prisma defaults field renames to `DROP COLUMN` + `ADD COLUMN`, permanently deleting data. | Use `RENAME COLUMN old TO new;` or use `@map("old_name")` in `schema.prisma`. |
| `set-not-null-full-scan`<br>`(set-not-null-full-scan)` | `ACCESS EXCLUSIVE` | **WARNING** (PG 12+)<br>**BLOCKER** (PG < 12) | Direct `ALTER COLUMN ... SET NOT NULL` forces synchronous full table scan under exclusive lock. | Add `CHECK (col IS NOT NULL) NOT VALID`, validate constraint, then apply `SET NOT NULL`. |
| `unbatched-dml`<br>`(unbatched-backfill)` | `ROW EXCLUSIVE` | **BLOCKER** (no `WHERE`)<br>**WARNING** (with `WHERE`) | Massive single-transaction `UPDATE`/`DELETE` generates heavy WAL bloat and lock convoys. | Batch in small slices (1,000–5,000 rows) via background jobs or add ignore directive. |
| `session-advisory-lock`<br>`(session-advisory-lock)` | `NONE` | **WARNING** | `pg_advisory_lock` leaks across connections in poolers (PgBouncer transaction mode). | Replace with transaction-scoped variants: `pg_advisory_xact_lock(...)`. |

---

## Detailed Rule Recipes

### 1. `check-constraint-not-valid`
```sql
-- ❌ Dangerous: Table scan under ACCESS EXCLUSIVE blocks all queries
ALTER TABLE orders ADD CONSTRAINT check_amt_positive CHECK (amount > 0);

-- ✅ Safe: Two-phase non-blocking validation
ALTER TABLE orders ADD CONSTRAINT check_amt_positive CHECK (amount > 0) NOT VALID;
ALTER TABLE orders VALIDATE CONSTRAINT check_amt_positive;
```

### 2. `unique-constraint-using-index`
```sql
-- ❌ Dangerous: SHARE lock blocks write traffic during index creation
ALTER TABLE users ADD CONSTRAINT uq_users_email UNIQUE (email);

-- ✅ Safe: Build index concurrently first, then attach instantly
CREATE UNIQUE INDEX CONCURRENTLY uq_users_email_idx ON users (email);
ALTER TABLE users ADD CONSTRAINT uq_users_email UNIQUE USING INDEX uq_users_email_idx;
```

### 3. `session-advisory-lock`
```sql
-- ❌ Dangerous: Session locks leak across PgBouncer connection pools
SELECT pg_advisory_lock(98765);

-- ✅ Safe: Transaction-scoped lock automatically releases on COMMIT or ROLLBACK
SELECT pg_advisory_xact_lock(98765);
```

### 4. `prisma-silent-rename-data-loss`
```sql
-- ❌ Dangerous: Prisma creates DROP + ADD on field renames, wiping data
ALTER TABLE "users" DROP COLUMN "full_name";
ALTER TABLE "users" ADD COLUMN "name" TEXT NOT NULL;

-- ✅ Safe: Rename in place without data loss
ALTER TABLE "users" RENAME COLUMN "full_name" TO "name";
```

---

## GitHub Actions CI/CD Integration

### 1. Basic Pull Request Gate (Check & Markdown Summary)

Fails the PR if any lock blockers are introduced, and posts the report to the GitHub Step Summary.

```yaml
name: Migration Safety Gate

on:
  pull_request:
    paths:
      - '**/migrations/**'
      - '**/*.sql'

jobs:
  ddlforge-lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Lint changed migrations
        run: npx ddlforge check --changed-only --format=terminal

      - name: Post Markdown summary to PR
        if: always()
        run: npx ddlforge check --changed-only --format=markdown >> $GITHUB_STEP_SUMMARY
```

### 2. GitHub Code Scanning & PR Annotations (SARIF 2.1.0)

Generates SARIF 2.1.0 results and uploads them to GitHub Code Scanning for inline pull request annotations.

```yaml
name: Migration Code Scanning

on:
  pull_request:
    paths:
      - '**/migrations/**'
      - '**/*.sql'
  push:
    branches: [main]

jobs:
  ddlforge-sarif:
    runs-on: ubuntu-latest
    permissions:
      security-events: write
      contents: read
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Run ddlforge SARIF inspection
        run: npx ddlforge check "prisma/migrations/**/*.sql" --format=sarif --output=ddlforge.sarif
        continue-on-error: true # Upload SARIF annotations even when blockers are present

      - name: Upload SARIF report to GitHub Security
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: ddlforge.sarif
          category: ddlforge-migrations
```

### 3. CD Deployment Pipeline with `ddlforge wrap`

Supervises production migration execution with automatic pre-flight verification:

```yaml
name: Production Deployment

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Install dependencies
        run: npm ci

      - name: Supervised Prisma Deployment
        env:
          DATABASE_URL: ${{ secrets.DATABASE_URL }}
        run: npx ddlforge wrap -- npx prisma migrate deploy
```

---

## Inline Directives

Suppress specific rules on individual statements when intentional:

```sql
-- ddlforge-ignore require-concurrent-index
CREATE INDEX idx_scratch ON scratch_buffer (temp_id);

-- ddlforge-ignore unbatched-dml
UPDATE app_config SET maintenance_mode = true;
```

Disable all checks for a specific statement:
```sql
-- ddlforge-ignore
ALTER TABLE legacy_import ADD COLUMN meta_data JSONB;
```

Disable Prisma implicit transaction wrapper (file-level):
```sql
-- prisma:no-transaction
CREATE INDEX CONCURRENTLY "users_email_idx" ON "users"("email");
```

---

## Programmatic TypeScript API

### Static Analysis (`analyzeSql`)

```typescript
import { analyzeSql, formatTerminal, formatSarif } from 'ddlforge';

const result = analyzeSql(`
  ALTER TABLE users ADD CONSTRAINT uq_email UNIQUE (email);
`, {
  filePath: 'migrations/001.sql',
  pgVersion: 16,
});

if (result.hasBlockers) {
  console.log(formatTerminal([result]));
  process.exit(1);
}
```

### ORM Wrapper (`orchestrateWrap`)

```typescript
import { orchestrateWrap } from 'ddlforge';

const result = await orchestrateWrap({
  dir: './prisma/migrations',
  databaseUrl: process.env.DATABASE_URL,
  allowBlockers: false,
  command: ['npx', 'prisma', 'migrate', 'deploy'],
});

process.exit(result.exitCode);
```

---

## Architecture

```
ddlforge/
├── bin/
│   └── ddlforge.ts              # Global executable CLI entrypoint
├── src/
│   ├── lexer/
│   │   ├── sqlTokenizer.ts      # Zero-dependency single-pass SQL lexer
│   │   └── tokens.ts            # Token & Statement definitions
│   ├── engine/
│   │   ├── analyzer.ts          # Static rule pipeline orchestrator
│   │   └── locks.ts             # Postgres lock levels & conflict taxonomy
│   ├── rules/                   # 10 zero-downtime safety rules
│   │   ├── indexConcurrently.ts
│   │   ├── transactionTrap.ts
│   │   ├── addColumnNotNull.ts
│   │   ├── foreignKeyNotValid.ts
│   │   ├── checkConstraintNotValid.ts
│   │   ├── uniqueConstraintUsingIndex.ts
│   │   ├── prismaRenameDropAdd.ts
│   │   ├── setNotNullFullScan.ts
│   │   ├── unbatchedBackfill.ts
│   │   └── sessionAdvisoryLock.ts
│   ├── wrapper/                 # wrap — ORM supervisor orchestrator
│   │   └── orchestrator.ts      # Pre-flight interceptor & child delegation
│   ├── runner/                  # apply — runtime execution supervisor
│   │   ├── backoff.ts           # Exponential backoff with full jitter
│   │   ├── locksMonitor.ts      # pg_locks background queue-avalanche breaker
│   │   └── executor.ts          # Non-transactional branching & timeouts
│   ├── reporters/
│   │   ├── terminal.ts          # Colorized human-readable report
│   │   ├── json.ts              # Machine-readable summary & findings
│   │   ├── markdown.ts          # GitHub Step Summary & PR comments
│   │   └── sarif.ts             # SARIF 2.1.0 for GitHub Code Scanning
│   └── cli.ts                   # CLI argument parser, check/apply/wrap dispatch
└── test/
    ├── analyzer.test.ts         # Lexer, core rules & CLI tests
    ├── linter.test.ts           # v0.3.0 rules & fixture verification tests
    ├── reporter.test.ts         # SARIF 2.1.0 schema & reporter tests
    ├── runner.test.ts           # Backoff, lock monitor, executor tests
    └── wrapper.test.ts          # ORM layout detection, pre-flight abort tests
```

---

## Testing & Performance

```bash
npm test
```

```text
✔ 132 tests passed across 31 suites (0 failures)
✔ analyzes 100 migrations in under 15 milliseconds
```

---

## License

MIT © [x7sss](https://github.com/x7ssss)

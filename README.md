# ddlforge

> **Ultra-fast, zero-runtime-dependency PostgreSQL migration lock linter & data-loss prevention engine.**  
> Built for Node.js 20+ and TypeScript. Designed for high-traffic Prisma, Drizzle, and raw SQL backends.

[![Node.js](https://img.shields.io/badge/Node.js-20%2B-green.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5%2B-blue.svg)](https://www.typescriptlang.org)
[![Zero Dependencies](https://img.shields.io/badge/Runtime%20Dependencies-0-success.svg)](package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## Why ddlforge?

In PostgreSQL, DDL commands take **table-level locks**. Even if a migration takes only milliseconds to run, if it requests an `ACCESS EXCLUSIVE` or `SHARE` lock while a long-running `SELECT` or transaction is open:
1. The migration stalls waiting for the lock.
2. **Every single query behind it is queued up**, including basic reads (`SELECT`).
3. Connection pools instantly exhaust within seconds, crashing services and taking down production.

Furthermore, ORMs like **Prisma Migrate** cannot detect column renames automatically: when you rename a field in `schema.prisma`, Prisma generates a `DROP COLUMN` followed by `ADD COLUMN`, permanently deleting all your production data!

`ddlforge` catches these architectural pitfalls in your local pre-commit hooks and CI pipelines before code ever merges to main.

### Design Principles
- **Zero Runtime Dependencies**: Pure native Node.js standard library (`node:fs`, `node:path`, `node:process`, `node:child_process`). Air-gap safe.
- **Sub-Second Performance**: Single-pass lexical scanner and linear rule evaluators. Scans 100+ migration files in **<10ms**.
- **Deterministic Exit Codes**: Exits `0` when clean or advisory-only; exits `1` for any blocking violation (table lock or destructive data loss).

---

## PostgreSQL Lock Hierarchy Reference

| Lock Mode | Acquired By | Conflicted Locks | Blocks Reads? | Blocks Writes? | Risk Level |
|:---|:---|:---|:---:|:---:|:---:|
| `ACCESS SHARE` | `SELECT` | `ACCESS EXCLUSIVE` | ❌ | ❌ | Low |
| `ROW SHARE` | `SELECT FOR UPDATE / FOR SHARE` | `EXCLUSIVE`, `ACCESS EXCLUSIVE` | ❌ | ❌ | Low |
| `ROW EXCLUSIVE` | `UPDATE`, `DELETE`, `INSERT` | `SHARE`, `SHARE ROW EXCLUSIVE`, `EXCLUSIVE`, `ACCESS EXCLUSIVE` | ❌ | ❌ | Medium |
| `SHARE UPDATE EXCLUSIVE` | `CREATE INDEX CONCURRENTLY`, `VACUUM`, `ANALYZE`, `VALIDATE CONSTRAINT` | `SHARE UPDATE EXCLUSIVE`, `SHARE`, `SHARE ROW EXCLUSIVE`, `EXCLUSIVE`, `ACCESS EXCLUSIVE` | ❌ | ❌ | **Safe for Concurrency** |
| `SHARE` | `CREATE INDEX` (non-concurrent) | `ROW EXCLUSIVE`, `SHARE ROW EXCLUSIVE`, `EXCLUSIVE`, `ACCESS EXCLUSIVE` | ❌ | **YES** | 🛑 **BLOCKER** |
| `SHARE ROW EXCLUSIVE` | `ADD CONSTRAINT FOREIGN KEY` (without `NOT VALID`) | `ROW EXCLUSIVE`, `SHARE UPDATE EXCLUSIVE`, `SHARE`, `SHARE ROW EXCLUSIVE`, `EXCLUSIVE`, `ACCESS EXCLUSIVE` | ❌ | **YES** | 🛑 **BLOCKER** |
| `EXCLUSIVE` | `REFRESH MATERIALIZED VIEW CONCURRENTLY` | `ROW SHARE`, `ROW EXCLUSIVE`, `SHARE UPDATE EXCLUSIVE`, `SHARE`, `SHARE ROW EXCLUSIVE`, `EXCLUSIVE`, `ACCESS EXCLUSIVE` | Row Share | **YES** | 🛑 **BLOCKER** |
| `ACCESS EXCLUSIVE` | `ALTER TABLE`, `DROP TABLE`, `TRUNCATE`, `ALTER COLUMN SET NOT NULL` | **ALL LOCK MODES** | **YES (SELECT)** | **YES** | 🚨 **CRITICAL DOWNTIME** |

---

## The 7 Core Rules & Zero-Downtime Recipes

### 1. `require-concurrent-index` (CREATE INDEX without CONCURRENTLY)
- **Severity**: `BLOCKER`
- **Lock**: `SHARE` lock (blocks all `INSERT`, `UPDATE`, `DELETE` operations on table).
- **Dangerous**:
  ```sql
  CREATE INDEX idx_users_email ON users(email);
  ```
- **Zero-Downtime Fix**:
  ```sql
  CREATE INDEX CONCURRENTLY idx_users_email ON users(email);
  ```

---

### 2. `concurrent-index-in-transaction` (CONCURRENTLY inside Transaction Trap)
- **Severity**: `BLOCKER`
- **Engine Behavior**: PostgreSQL aborts with `ERROR: CREATE INDEX CONCURRENTLY cannot run inside a transaction block`.
- **Dangerous**:
  ```sql
  BEGIN;
  CREATE INDEX CONCURRENTLY idx_users_email ON users(email);
  COMMIT;
  ```
- **Prisma Caveat**: Prisma Migrate wraps all migrations in an implicit transaction by default. Running `CREATE INDEX CONCURRENTLY` in Prisma fails unless you add the `-- prisma:no-transaction` directive.
- **Zero-Downtime Fix**:
  ```sql
  -- prisma:no-transaction
  CREATE INDEX CONCURRENTLY "users_email_idx" ON "users"("email");
  ```

---

### 3. `add-column-not-null-without-default` (ADD COLUMN NOT NULL without DEFAULT)
- **Severity**: `BLOCKER`
- **Lock**: `ACCESS EXCLUSIVE` lock.
- **Dangerous**:
  ```sql
  ALTER TABLE users ADD COLUMN role VARCHAR(50) NOT NULL;
  ```
- **Why**: On non-empty tables, PostgreSQL immediately aborts with `ERROR: column "role" contains null values` while holding an `ACCESS EXCLUSIVE` table lock.
- **Zero-Downtime Fix (PG 11+)**:
  Provide a static non-volatile default (metadata-only instant operation):
  ```sql
  ALTER TABLE users ADD COLUMN role VARCHAR(50) DEFAULT 'user' NOT NULL;
  ```
  Or for dynamic/custom defaults, use the multi-step backfill pattern:
  ```sql
  -- Step 1: Add column nullable
  ALTER TABLE users ADD COLUMN role VARCHAR(50);
  -- Step 2: Batched backfill
  -- Step 3: Add CHECK constraint NOT VALID & validate
  ALTER TABLE users ADD CONSTRAINT chk_role_not_null CHECK (role IS NOT NULL) NOT VALID;
  ALTER TABLE users VALIDATE CONSTRAINT chk_role_not_null;
  ```

---

### 4. `foreign-key-missing-not-valid` (ADD CONSTRAINT FOREIGN KEY without NOT VALID)
- **Severity**: `BLOCKER`
- **Lock**: `SHARE ROW EXCLUSIVE` on referencing table + `SHARE` on referenced table.
- **Dangerous**:
  ```sql
  ALTER TABLE orders ADD CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id);
  ```
- **Zero-Downtime Fix**:
  Split into two non-blocking steps:
  ```sql
  -- Step 1: Add constraint without scanning rows (instant metadata operation)
  ALTER TABLE orders ADD CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id) NOT VALID;

  -- Step 2: Validate concurrently (takes only SHARE UPDATE EXCLUSIVE, reads & writes proceed!)
  ALTER TABLE orders VALIDATE CONSTRAINT fk_user;
  ```

---

### 5. `prisma-silent-rename-data-loss` (Prisma Silent Field Rename)
- **Severity**: `BLOCKER` (Data-Loss Prevention)
- **Lock**: `ACCESS EXCLUSIVE` + Table Data Loss.
- **Dangerous**:
  ```sql
  ALTER TABLE "users" DROP COLUMN "old_name";
  ALTER TABLE "users" ADD COLUMN "new_name" TEXT NOT NULL;
  ```
- **Why**: Prisma Migrate cannot infer renames from `schema.prisma`. It generates a column drop followed by column creation, destroying all production data.
- **Zero-Downtime Fix**:
  ```sql
  ALTER TABLE "users" RENAME COLUMN "old_name" TO "new_name";
  ```
  Or use Prisma's `@map("old_name")` in your schema to avoid database column renames.

---

### 6. `set-not-null-full-scan` (ALTER COLUMN SET NOT NULL)
- **Severity**: `WARNING` (or `BLOCKER` on PG < 12)
- **Lock**: `ACCESS EXCLUSIVE` lock while scanning entire table for nulls.
- **Dangerous**:
  ```sql
  ALTER TABLE users ALTER COLUMN email SET NOT NULL;
  ```
- **Zero-Downtime Fix (PG 12+)**:
  ```sql
  -- 1. Add CHECK constraint NOT VALID (instant)
  ALTER TABLE users ADD CONSTRAINT chk_users_email_not_null CHECK (email IS NOT NULL) NOT VALID;
  -- 2. Validate constraint without blocking writes
  ALTER TABLE users VALIDATE CONSTRAINT chk_users_email_not_null;
  -- 3. Set NOT NULL (Postgres 12+ skips table scan because validated CHECK constraint exists!)
  ALTER TABLE users ALTER COLUMN email SET NOT NULL;
  ```

---

### 7. `unbatched-dml` (Unbatched DML in Migration)
- **Severity**: `WARNING` (or `BLOCKER` without WHERE)
- **Lock**: `ROW EXCLUSIVE` lock on touched rows, massive transaction WAL bloat.
- **Dangerous**:
  ```sql
  UPDATE users SET active = true;
  DELETE FROM sessions;
  ```
- **Zero-Downtime Fix**:
  Perform large backfills out-of-band using batched background workers. If updating a small static/seed table, exempt with an inline comment:
  ```sql
  -- ddlforge-ignore unbatched-dml
  UPDATE subscription_tiers SET active = true WHERE code = 'PRO';
  ```

---

## CLI Installation & Usage

### Running via npx (Zero Install)
```bash
npx ddlforge ./prisma/migrations
```

### Local Installation
```bash
npm install --save-dev ddlforge
```

### CLI Flags
```text
ddlforge [paths...] [flags]

ARGUMENTS:
  paths               Target migration files or directories (e.g. ./prisma/migrations, ./drizzle)

FLAGS:
  --pg <version>      Target PostgreSQL version (default: 16)
  --format <type>     Output format: terminal | json | markdown (default: terminal)
  --quiet, -q         Suppress advisories/warnings and emit blockers only
  --changed-only      Use git diff to lint only staged or branch-modified migration files
  --version, -v       Print ddlforge version and exit
  --help, -h          Print this help message and exit
```

### Examples
```bash
# Lint all Prisma migrations
npx ddlforge ./prisma/migrations

# Lint only modified migration files in current git branch / PR
npx ddlforge --changed-only

# Check Drizzle migrations targeting Postgres 14 with JSON output
npx ddlforge ./drizzle --pg 14 --format json

# CI Mode: Emit blockers only with exit code 1
npx ddlforge ./migrations --quiet
```

---

## GitHub Actions Workflow

Add this copy-paste workflow to `.github/workflows/migration-lint.yml`:

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
      - name: Checkout Code
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Run ddlforge Lock Linter
        run: |
          npx ddlforge --changed-only --format terminal
```

### PR Comment Workflow (with Markdown Formatter)
```yaml
      - name: Generate Migration Safety Report
        if: always()
        run: |
          npx ddlforge --changed-only --format markdown > report.md
          cat report.md >> $GITHUB_STEP_SUMMARY
```

---

## Programmatic TypeScript API

You can also use `ddlforge` programmatically within your custom deployment scripts:

```typescript
import { analyzeSql, MigrationAnalyzer, formatTerminal } from 'ddlforge';

const sql = `
  CREATE INDEX idx_users_email ON users(email);
`;

const result = analyzeSql(sql, {
  filePath: 'migrations/001_create_index.sql',
  pgVersion: 16,
});

if (result.hasBlockers) {
  console.error(`Found ${result.blockersCount} blocking migration locks!`);
  console.log(formatTerminal([result]));
  process.exit(1);
}
```

---

## Inline Directives

You can suppress specific rules per statement using inline comments:

```sql
-- ddlforge-ignore require-concurrent-index
CREATE INDEX idx_temp ON temporary_cache(key);

-- ddlforge-ignore unbatched-dml
UPDATE plan_limits SET max_seats = 100 WHERE plan_id = 'enterprise';
```

For Prisma migrations containing `CONCURRENTLY`:
```sql
-- prisma:no-transaction
CREATE INDEX CONCURRENTLY "users_email_idx" ON "users"("email");
```

---

## Testing & Verification

Run the native test suite:
```bash
npm test
```

Performance benchmark:
```text
✔ analyzes 100 migrations in under 100 milliseconds (9.2ms)
```

---

## License

MIT © [x7sss](https://github.com/x7ssss)

/**
 * ddlforge - Zero-dependency custom CLI argument parser and execution engine
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { MigrationAnalyzer, AnalysisResult } from './engine/analyzer.js';
import { formatTerminal } from './reporters/terminal.js';
import { formatJson } from './reporters/json.js';
import { formatMarkdown } from './reporters/markdown.js';
import { formatSarif } from './reporters/sarif.js';
import { formatGithub } from './reporters/github.js';
// executor is imported dynamically inside runApply() to preserve
// zero-dependency invariant for static linting (ddlforge check).

export interface CliOptions {
  targets: string[];
  pgVersion: number;
  format: 'terminal' | 'json' | 'markdown' | 'sarif' | 'github';
  output?: string;
  quiet: boolean;
  changedOnly: boolean;
  fix: boolean;
  help: boolean;
  version: boolean;
}

/** Options parsed from `ddlforge apply <file> --db <url> [flags]` */
export interface ApplyOptions {
  file: string;
  databaseUrl: string;
  lockTimeout: string;
  statementTimeout: string;
  maxRetries: number;
  dryRun: boolean;
  lockQueueThreshold: number;
  monitorPollMs: number;
  help: boolean;
}

export const VERSION = '1.9.0';

export function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    targets: [],
    pgVersion: 16,
    format: 'terminal',
    output: undefined,
    quiet: false,
    changedOnly: false,
    fix: false,
    help: false,
    version: false,
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    if (arg === '--help' || arg === '-h') {
      options.help = true;
      i++;
      continue;
    }

    if (arg === '--version' || arg === '-v') {
      options.version = true;
      i++;
      continue;
    }

    if (arg === '--fix') {
      options.fix = true;
      i++;
      continue;
    }

    if (arg === '--quiet' || arg === '-q') {
      options.quiet = true;
      i++;
      continue;
    }

    if (arg === '--changed-only') {
      options.changedOnly = true;
      i++;
      continue;
    }

    if (arg === '--pg') {
      i++;
      if (i < args.length) {
        options.pgVersion = parseInt(args[i], 10) || 16;
      }
      i++;
      continue;
    }
    if (arg.startsWith('--pg=')) {
      options.pgVersion = parseInt(arg.slice(5), 10) || 16;
      i++;
      continue;
    }

    if (arg === '--output' || arg === '-o') {
      i++;
      if (i < args.length) {
        options.output = args[i];
      }
      i++;
      continue;
    }
    if (arg.startsWith('--output=')) {
      options.output = arg.slice('--output='.length);
      i++;
      continue;
    }

    if (arg === '--format') {
      i++;
      if (i < args.length) {
        const fmt = args[i].toLowerCase();
        if (fmt === 'pretty') {
          options.format = 'terminal';
        } else if (fmt === 'json' || fmt === 'markdown' || fmt === 'terminal' || fmt === 'sarif' || fmt === 'github') {
          options.format = fmt;
        }
      }
      i++;
      continue;
    }
    if (arg.startsWith('--format=')) {
      const fmt = arg.slice(9).toLowerCase();
      if (fmt === 'pretty') {
        options.format = 'terminal';
      } else if (fmt === 'json' || fmt === 'markdown' || fmt === 'terminal' || fmt === 'sarif' || fmt === 'github') {
        options.format = fmt;
      }
      i++;
      continue;
    }

    // Positional target
    if (!arg.startsWith('-')) {
      options.targets.push(arg);
    }

    i++;
  }

  return options;
}

export function printHelp(): void {
  console.log(`
ddlforge v${VERSION} — Ultra-fast, zero-dependency Postgres migration lock linter

USAGE:
  ddlforge [paths...] [flags]              # lint/check migrations
  ddlforge preflight [file.sql] [options]  # pre-flight blast radius, disk capacity & WAL forecasting
  ddlforge partition <cmd> [options]       # declarative partition lifecycle (convert, attach, detach, maintenance)
  ddlforge run <file.sql> --db <url>       # execute migration with autonomous lock pre-emption
  ddlforge top [options]                   # real-time lock contention & deadlock graph visualizer
  ddlforge diff [options]                  # compare live database schema against migration ASTs
  ddlforge lock <status|release> [options] # inspect or clear distributed advisory locks
  ddlforge mask <trigger|backfill|advice>  # in-flight data masking & PII anonymization
  ddlforge apply <file.sql> --db <url>     # apply a migration safely
  ddlforge wrap [options] -- <command...>  # supervise ORM migration deployments
  ddlforge split <file.sql>                # split mixed migration into tx and autocommit phases
  ddlforge forge --orm <type> <file.sql>   # generate ledger SQL to mark out-of-band migration completed
  ddlforge expand <file.sql> --version <v> # generate virtual schema views with INSTEAD OF triggers
  ddlforge backfill --table <table> ...    # generate resumable keyset pagination backfill procedure
  ddlforge contract --table <table> ...    # generate GitLab 3-release teardown script
  ddlforge test [options]                  # run migrations against ephemeral PostgreSQL container
  ddlforge doctor [options]                # continuous WAL archival health & disaster recovery readiness
  ddlforge compact <estimate|table|index>  # zero-downtime table compaction & bloat estimator
  ddlforge tenant <migrate|audit|sweep>    # multi-tenant distribution & drift auditing
  ddlforge advisor <analyze|simulate|prune> # autonomous telemetry, hypopg simulation & index pruner

── ADVISOR (query telemetry, hypopg simulation & index pruner) ─
  ddlforge advisor analyze [options]
  ddlforge advisor simulate --query <sql> --index <sql> [options]
  ddlforge advisor prune [options]

SUBCOMMANDS:
  analyze             Mine table Read/Write ratios, HOT update efficiencies, and slow queries
  simulate            Simulate hypothetical index in-memory with hypopg to calculate cost reduction
  prune               Discover unused, prefix-subsumed redundant, and invalid indexes

ANALYZE FLAGS:
  --db <url>          PostgreSQL connection URL (or DATABASE_URL)
  --table <table>     Filter by specific table name (optional)
  --schema <name>     Target PostgreSQL schema (default: public)
  --limit <n>         Max slow queries to display from pg_stat_statements (default: 10)
  --format <type>     Output format: terminal | json (default: terminal)

SIMULATE FLAGS:
  --db <url>          PostgreSQL connection URL (or DATABASE_URL)
  --query <sql>       SQL query to benchmark with EXPLAIN (FORMAT JSON)
  --index <sql>       CREATE INDEX statement to simulate in-memory
  --format <type>     Output format: terminal | json (default: terminal)

PRUNE FLAGS:
  --db <url>          PostgreSQL connection URL (or DATABASE_URL)
  --table <table>     Filter by specific table name (optional)
  --schema <name>     Target PostgreSQL schema (default: public)
  --min-size-mb <n>   Minimum index size in MB to consider for pruning (default: 0)
  --max-scans <n>     Maximum index scans to qualify as unused (default: 0)
  --drop              Execute DROP INDEX CONCURRENTLY on safe prunable candidates
  --format <type>     Output format: terminal | json (default: terminal)

── TENANT (multi-tenant distribution & drift auditing) ─────────
  ddlforge tenant migrate [options]
  ddlforge tenant audit [options]
  ddlforge tenant sweep [options]

SUBCOMMANDS:
  migrate             Distribute DDL migration across multi-tenant fleet (schema or database)
  audit               Audit cross-tenant schema drift and generate zero-downtime reconciliation SQL
  sweep               Self-healing sweeper for stale/orphaned distributed DDL runs

MIGRATE FLAGS:
  --strategy <type>   Multi-tenant topology: schema | database (default: schema)
  --pattern <glob>    Schema name pattern for schema-per-tenant (default: tenant_*)
  --file <path>       Migration SQL file to execute across tenants
  --concurrency <n>   Concurrent worker pool limit (default: 8)
  --rate-limit <n>    Maximum tenant operations per second
  --db <url>          PostgreSQL connection URL (or DATABASE_URL)
  --config <path>     JSON config file for database-per-tenant strategy
  --format <type>     Output format: terminal | json (default: terminal)

AUDIT FLAGS:
  --strategy <type>   Multi-tenant topology: schema | database (default: schema)
  --pattern <glob>    Schema name pattern for schema-per-tenant (default: tenant_*)
  --golden <name>     Reference golden tenant/schema (default: auto-detected by consensus)
  --db <url>          PostgreSQL connection URL (or DATABASE_URL)
  --format <type>     Output format: terminal | json (default: terminal)

SWEEP FLAGS:
  --db <url>          PostgreSQL connection URL (or DATABASE_URL)
  --max-age-minutes <n> Age threshold in minutes for stale PREPARED runs (default: 30)
  --auto-heal         Automatically heal stale runs if fleet consensus succeeded (default: true)
  --dry-run           Preview sweep decisions without updating ledger table
  --format <type>     Output format: terminal | json (default: terminal)

── COMPACT (zero-downtime table compaction & bloat estimator) ──────
  ddlforge compact estimate [options]
  ddlforge compact table --table <table> --pk <id> [options]
  ddlforge compact index --table <table> [--index <name>]

SUBCOMMANDS:
  estimate            Mathematically estimate table and B-Tree index bloat without seqscans
  table               Generate 5-phase zero-downtime online table repack SQL script
  index               Generate autocommit-safe lock-free concurrent index rebuild statement

TABLE REPACK FLAGS:
  --table <table>     Monolithic table name to compact (required)
  --pk <id>           Primary key column for keyset backfill (default: id)
  --pk-type <type>    Primary key column data type (default: BIGINT)
  --batch-size <n>    Backfill and replay batch size per commit (default: 5000)
  --throttle-ms <n>   Jittered sleep throttle between batches in ms (default: 20)
  --lock-timeout <t>  Cutover transaction lock timeout (default: 250ms)
  --statement-timeout <t> Cutover statement timeout (default: 5s)
  --fillfactor <n>    Fillfactor for repacked shadow table (e.g. 85 or 90)
  --tablespace <name> Target tablespace for shadow table
  --schema <name>     Target PostgreSQL schema (default: public)

ESTIMATE FLAGS:
  --db <url>          PostgreSQL connection URL (or DATABASE_URL env var)
  --table <table>     Filter by specific table name (optional)
  --schema <name>     Target PostgreSQL schema (default: public)
  --threshold <pct>   Bloat percentage threshold for repack recommendation (default: 25)
  --format <type>     Output format: terminal | json (default: terminal)

── DOCTOR (continuous WAL archiving & disaster recovery) ───────────
  ddlforge doctor [options]

FLAGS:
  --db <url>          PostgreSQL connection URL (or DATABASE_URL env var)
  --stale-minutes <n> Archive staleness threshold in minutes (default: 15)
  --max-lag-mb <n>    Standby replay lag threshold in MB (default: 100)
  --format <type>     Output format: terminal | json (default: terminal)

── VERIFY-BACKUP (restore validation & amcheck integrity) ──────────
  ddlforge verify-backup [options]

FLAGS:
  --target-url <url>  Target restored PostgreSQL URL (or DATABASE_URL env var)
  --db <url>          Alias for --target-url
  --rpo-hours <n>     Maximum acceptable RPO threshold in hours (default: 24)
  --skip-amcheck      Skip B-Tree index corruption checks via amcheck
  --format <type>     Output format: terminal | json (default: terminal)

── PREFLIGHT (disk capacity, blast radius & WAL forecasting) ───────────
  ddlforge preflight <file.sql> [options]

ARGUMENTS:
  <file.sql>          Migration SQL file to evaluate (optional)

FLAGS:
  --db <url>          PostgreSQL connection URL (or DATABASE_URL env var)
  --target-table <t>  Target table name for disk footprint estimation
  --operation <type>  Operation type: create_index | table_rewrite | auto (default: auto)
  --available-bytes <n> Available disk space in bytes (overrides live OS query)
  --table-bytes <n>   Table size in bytes (for static/simulation runs)
  --toast-bytes <n>   TOAST size in bytes (for static/simulation runs)
  --indexes-bytes <n> Indexes size in bytes (for static/simulation runs)
  --tuples <n>        Live + dead tuple count (for static/simulation runs)
  --max-lag-mb <n>    Maximum acceptable replica lag in MB (default: 100)
  --max-lag-sec <n>   Maximum acceptable replica lag in seconds (default: 10)
  --schema <name>     Target PostgreSQL schema (default: public)
  --format <type>     Output format: terminal | json (default: terminal)

── PARTITION (declarative partition lifecycle) ─────────────────────────
  ddlforge partition convert --table <table> --key <column> [options]
  ddlforge partition attach --parent <tbl> --partition <part> --from <val> --to <val> [options]
  ddlforge partition detach --parent <tbl> --partition <part> [--concurrent] [options]
  ddlforge partition maintenance --parent <tbl> [options]

SUBCOMMANDS:
  convert             Generate zero-downtime 4-phase monolithic table conversion script
  attach              Generate safe scan-skipping partition attachment script (3-phase)
  detach              Generate safe autocommit-safe partition detachment script
  maintenance         Generate rolling forward pre-allocation and retention pruning procedure

CONVERT FLAGS:
  --table <table>     Monolithic table name to convert (required)
  --key <column>      Partition key column (required)
  --type <range|list> Partition strategy: range | list (default: range)
  --pk <col>          Primary key column for keyset backfill (default: id)
  --batch-size <n>    Backfill batch size per commit (default: 5000)
  --throttle-ms <n>   Jittered sleep throttle between batches in ms (default: 50)
  --schema <name>     Target PostgreSQL schema (default: public)

ATTACH FLAGS:
  --parent <tbl>      Parent partitioned table name (required)
  --partition <part>  Partition table name to attach (required)
  --from <val>        Lower partition boundary value (required)
  --to <val>          Upper partition boundary value (required)
  --key <col>         Partition key column name (default: created_at)
  --schema <name>     Target PostgreSQL schema (default: public)
  --constraint-name <name> Boundary CHECK constraint name (default: <part>_bnd_chk)

DETACH FLAGS:
  --parent <tbl>      Parent partitioned table name (required)
  --partition <part>  Partition table name to detach (required)
  --concurrent        Execute concurrent autocommit detachment (default: true)
  --no-concurrent     Execute standard non-concurrent detachment
  --schema <name>     Target PostgreSQL schema (default: public)

MAINTENANCE FLAGS:
  --parent <tbl>      Parent partitioned table name (required)
  --interval <type>   Partition interval: monthly | daily (default: monthly)
  --premake <n>       Number of future partitions to pre-allocate (default: 3)
  --retention <n>     Number of intervals before detachment (default: 12)
  --lock-timeout <t>  Bounded lock timeout during maintenance (default: 2s)
  --schema <name>     Target PostgreSQL schema (default: public)

── RUN (autonomous circuit breaker execution) ────────────────────────
  ddlforge run <file.sql> --db <url> [options]

ARGUMENTS:
  <file.sql>          Migration SQL file to execute

FLAGS:
  --db <url>          PostgreSQL connection URL (required)
  --max-queue <n>     Maximum blocked queries before pre-emption trip (default: 5)
  --max-wait-ms <n>   Maximum wait time in ms before pre-emption trip (default: 200)
  --retries <n>       Maximum retry attempts with decorrelated jitter (default: 50)
  --base-delay-ms <n> Initial base delay in ms for backoff (default: 100)
  --cap-delay-ms <n>  Maximum delay cap in ms for backoff (default: 5000)

── TOP (deadlock & contention visualizer) ─────────────────────────────
  ddlforge top --db <url> [options]

FLAGS:
  --db <url>          PostgreSQL connection URL (defaults to DATABASE_URL)
  --format <type>     Output format: terminal | json (default: terminal)
  --watch             Continuously refresh lock contention graph every 1s

── MASK (in-flight PII anonymization) ────────────────────────────────
  ddlforge mask trigger --table <table> --columns <col:type,...> [options]
  ddlforge mask backfill --table <table> --columns <col:type,...> [options]
  ddlforge mask advice --table <table> [options]

SUBCOMMANDS:
  trigger             Generate in-flight BEFORE INSERT OR UPDATE masking triggers
  backfill            Generate keyset pagination batch procedure for historical data
  advice              Emit storage, HOT update, and telemetry hardening recommendations

FLAGS:
  --table <table>     Target table name
  --columns <list>    Comma-separated list of column:type pairs (types: email, integer, uuid, text, custom)
  --pk <id>           Primary key column for keyset backfill (default: id)
  --batch-size <n>    Batch size per backfill transaction commit (default: 2500)
  --schema <name>     Target PostgreSQL schema (default: public)
  --fillfactor <n>    Recommended table fillfactor for HOT optimization (default: 85)
  --format <type>     Advisory output format: terminal | json (default: terminal)
  --salt-guc <name>   Session GUC variable storing masking salt (default: app.masking_salt)

── DIFF (live schema drift) ──────────────────────────────────────────
  ddlforge diff [--db <url>] [--dir <path>] [--format <terminal|json>]

FLAGS:
  --db <url>          PostgreSQL connection URL (defaults to DATABASE_URL)
  --dir <path>        Directory or files containing target migration SQL
  --schema <name>     Target PostgreSQL schema to introspect (default: public)
  --format <type>     Output format: terminal | json (default: terminal)

── LOCK (distributed advisory clustering) ────────────────────────────
  ddlforge lock <status|release> [options]

COMMANDS:
  status              List active and stale distributed advisory locks
  release             Release stale advisory locks or clear ddlforge_run state

FLAGS:
  --db <url>          PostgreSQL connection URL (defaults to DATABASE_URL)
  --project <name>    Filter by project name
  --force             Force clear all records even if heartbeat is recent

── CHECK (lint) ──────────────────────────────────────────────────────
ARGUMENTS:
  paths               Target migration files or directories (e.g. ./prisma/migrations, ./drizzle)

FLAGS:
  --pg <version>      Target PostgreSQL version (default: 16)
  --format <type>     Output format: terminal | json | markdown | sarif | github (default: terminal)
  --quiet, -q         Suppress advisories/warnings and emit blockers only
  --changed-only      Use git diff to lint only staged or branch-modified migration files
  --fix               Automatically apply safe remediation recipes in-place for detected blockers
  --version, -v       Print ddlforge version and exit
  --help, -h          Print this help message and exit

  GitHub CI usage:
    ddlforge check ./migrations --format github
    # Emits ::error and ::warning workflow commands for inline PR annotations

── EXPAND (virtual schema) ───────────────────────────────────────────
  ddlforge expand <migration-file.sql> --version <v1|v2>

ARGUMENTS:
  <migration-file.sql> Migration SQL defining tables/columns for the new version

FLAGS:
  --version <v1|v2>   Version tag for virtual schema (default: v2)

── BACKFILL (keyset pagination) ──────────────────────────────────────
  ddlforge backfill --table <table> --from <col_old> --to <col_new> [--pk <id>]

FLAGS:
  --table <table>     Target table name
  --from <col_old>    Source column name
  --to <col_new>      Target column name
  --pk <id>           Primary key column name (default: id)
  --batch-size <n>    Batch size per transaction commit (default: 5000)

── CONTRACT (3-release teardown) ─────────────────────────────────────
  ddlforge contract --table <table> --column <legacy_col> [--schema <public_v1>]

FLAGS:
  --table <table>       Target physical table
  --column <legacy_col> Deprecated legacy column to drop
  --schema <public_v1>  Deprecated virtual schema to drop (default: public_v1)

── SPLIT (slice migration) ───────────────────────────────────────────
  ddlforge split <file.sql>

ARGUMENTS:
  <file.sql>          Mixed migration file to split into phase1_tx and phase2_autocommit

── FORGE (ledger SQL) ────────────────────────────────────────────────
  ddlforge forge --orm <prisma|drizzle> <file.sql>

ARGUMENTS:
  <file.sql>          Target migration file to generate ledger record for

FLAGS:
  --orm <type>        Target ORM: prisma | drizzle (required)

── APPLY (execute) ───────────────────────────────────────────────────
  ddlforge apply <file.sql> --db <DATABASE_URL> [flags]

ARGUMENTS:
  <file.sql>                  SQL migration file to execute

FLAGS:
  --db <url>                  PostgreSQL connection URL (required)
  --lock-timeout <ms>         Per-statement lock_timeout in milliseconds (default: 3000)
  --statement-timeout <ms>    Per-statement statement_timeout in milliseconds (default: 30000)
  --max-retries <n>           Maximum retry attempts on lock timeout (default: 5)
  --dry-run                   Parse and display statements without executing
  --lock-queue-threshold <n>  Blocked-backend count that triggers cancellation (default: 1)
  --monitor-poll-ms <ms>      Lock-monitor polling interval in milliseconds (default: 500)
  --help, -h                  Print this help message and exit

── WRAP (supervise ORM) ──────────────────────────────────────────────
  ddlforge wrap [options] -- <command...>

ARGUMENTS:
  <command...>        Migration deployment command to run after safety checks

FLAGS:
  --dir <path>        Migration directory to scan (defaults: auto-detect prisma/migrations, drizzle, or ./migrations)
  --allow-blockers    Warn on blockers instead of aborting the command
  --db <url>          Database URL for pending migration checks (falls back to DATABASE_URL)
  --help, -h          Print this help message and exit

EXAMPLES:
  $ ddlforge ./prisma/migrations
  $ ddlforge ./drizzle --pg 14 --format json
  $ ddlforge --changed-only
  $ ddlforge ./migrations/001_add_index.sql --fix
  $ ddlforge split ./migrations/001_mixed.sql
  $ ddlforge forge --orm prisma ./prisma/migrations/20260918_add_idx/migration.sql
  $ ddlforge forge --orm drizzle ./drizzle/0001_initial.sql
  $ ddlforge expand ./migrations/002_add_bio.sql --version v2
  $ ddlforge backfill --table users --from name --to full_name --pk id
  $ ddlforge contract --table users --column name --schema public_v1
  $ ddlforge apply ./migrations/001_add_index.sql --db postgres://localhost/mydb
  $ ddlforge apply ./migrations/001_add_index.sql --db postgres://localhost/mydb --dry-run
  $ ddlforge wrap -- npx prisma migrate deploy
  $ ddlforge wrap --dir=./drizzle -- npx drizzle-kit migrate
`);
}

/**
 * Parses arguments for the `apply` subcommand.
 * argv should be the args AFTER the "apply" token.
 */
export function parseApplyArgs(argv: string[]): ApplyOptions {
  const opts: ApplyOptions = {
    file:               '',
    databaseUrl:        process.env['DATABASE_URL'] ?? '',
    lockTimeout:        '3000ms',
    statementTimeout:   '30000ms',
    maxRetries:         5,
    dryRun:             false,
    lockQueueThreshold: 1,
    monitorPollMs:      500,
    help:               false,
  };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') {
      opts.help = true;
      i++;
      continue;
    }

    if (arg === '--dry-run') {
      opts.dryRun = true;
      i++;
      continue;
    }

    const nextArg = (): string => {
      i++;
      return i < argv.length ? argv[i] : '';
    };

    if (arg === '--db' || arg === '--database-url') {
      opts.databaseUrl = nextArg();
      i++;
      continue;
    }
    if (arg.startsWith('--db=')) {
      opts.databaseUrl = arg.slice('--db='.length);
      i++;
      continue;
    }

    if (arg === '--lock-timeout') {
      const val = nextArg();
      opts.lockTimeout = val.endsWith('ms') ? val : `${val}ms`;
      i++;
      continue;
    }
    if (arg.startsWith('--lock-timeout=')) {
      const val = arg.slice('--lock-timeout='.length);
      opts.lockTimeout = val.endsWith('ms') ? val : `${val}ms`;
      i++;
      continue;
    }

    if (arg === '--statement-timeout') {
      const val = nextArg();
      opts.statementTimeout = val.endsWith('ms') ? val : `${val}ms`;
      i++;
      continue;
    }
    if (arg.startsWith('--statement-timeout=')) {
      const val = arg.slice('--statement-timeout='.length);
      opts.statementTimeout = val.endsWith('ms') ? val : `${val}ms`;
      i++;
      continue;
    }

    if (arg === '--max-retries') {
      opts.maxRetries = parseInt(nextArg(), 10) || 5;
      i++;
      continue;
    }
    if (arg.startsWith('--max-retries=')) {
      opts.maxRetries = parseInt(arg.slice('--max-retries='.length), 10) || 5;
      i++;
      continue;
    }

    if (arg === '--lock-queue-threshold') {
      opts.lockQueueThreshold = parseInt(nextArg(), 10) || 1;
      i++;
      continue;
    }
    if (arg.startsWith('--lock-queue-threshold=')) {
      opts.lockQueueThreshold = parseInt(arg.slice('--lock-queue-threshold='.length), 10) || 1;
      i++;
      continue;
    }

    if (arg === '--monitor-poll-ms') {
      opts.monitorPollMs = parseInt(nextArg(), 10) || 500;
      i++;
      continue;
    }
    if (arg.startsWith('--monitor-poll-ms=')) {
      opts.monitorPollMs = parseInt(arg.slice('--monitor-poll-ms='.length), 10) || 500;
      i++;
      continue;
    }

    // Positional: the SQL file
    if (!arg.startsWith('-') && opts.file === '') {
      opts.file = arg;
    }

    i++;
  }

  return opts;
}


/**
 * Finds all .sql files from input paths, directories, or defaults.
 */
export function discoverSqlFiles(targets: string[], changedOnly: boolean, cwd: string = process.cwd()): string[] {
  if (changedOnly) {
    return getChangedSqlFiles(cwd);
  }

  const filesToScan: string[] = [];

  const candidateTargets = targets.length > 0
    ? targets
    : findDefaultMigrationTargets(cwd);

  for (const target of candidateTargets) {
    const fullPath = path.isAbsolute(target) ? target : path.resolve(cwd, target);
    if (!fs.existsSync(fullPath)) continue;

    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      collectSqlFromDir(fullPath, filesToScan);
    } else if (stat.isFile() && (fullPath.endsWith('.sql') || targets.length > 0)) {
      filesToScan.push(fullPath);
    }
  }

  return filesToScan;
}

function findDefaultMigrationTargets(cwd: string): string[] {
  const commonDirs = [
    'prisma/migrations',
    'drizzle',
    'migrations',
    'sql',
  ];

  const found: string[] = [];
  for (const dir of commonDirs) {
    const p = path.resolve(cwd, dir);
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
      found.push(p);
    }
  }

  return found.length > 0 ? found : [cwd];
}

function collectSqlFromDir(dir: string, accumulator: string[]): void {
  const IGNORED = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.turbo']);

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!IGNORED.has(entry.name)) {
        collectSqlFromDir(path.join(dir, entry.name), accumulator);
      }
    } else if (entry.isFile() && entry.name.endsWith('.sql')) {
      accumulator.push(path.join(dir, entry.name));
    }
  }
}

function getChangedSqlFiles(cwd: string): string[] {
  const resultFiles = new Set<string>();

  // 1. Try git diff --name-only HEAD (staged and unstaged against HEAD)
  try {
    const diffHead = execSync('git diff --name-only HEAD', { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
    diffHead
      .split(/\r?\n/)
      .map((f: string) => f.trim())
      .filter((f: string) => f.endsWith('.sql') && f.length > 0)
      .forEach((f: string) => {
        const full = path.resolve(cwd, f);
        if (fs.existsSync(full)) resultFiles.add(full);
      });
  } catch {
    // If no commits yet / no HEAD commit
    try {
      const unstaged = execSync('git diff --name-only', { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
      unstaged
        .split(/\r?\n/)
        .map((f: string) => f.trim())
        .filter((f: string) => f.endsWith('.sql') && f.length > 0)
        .forEach((f: string) => {
          const full = path.resolve(cwd, f);
          if (fs.existsSync(full)) resultFiles.add(full);
        });
    } catch {}

    try {
      const staged = execSync('git diff --name-only --cached', { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
      staged
        .split(/\r?\n/)
        .map((f: string) => f.trim())
        .filter((f: string) => f.endsWith('.sql') && f.length > 0)
        .forEach((f: string) => {
          const full = path.resolve(cwd, f);
          if (fs.existsSync(full)) resultFiles.add(full);
        });
    } catch {}
  }

  return Array.from(resultFiles);
}

export async function runCli(argv: string[] = process.argv.slice(2)): Promise<number> {
  // Detect apply subcommand
  if (argv[0] === 'apply') {
    return runApply(argv.slice(1));
  }

  // Detect wrap subcommand
  if (argv[0] === 'wrap') {
    const { runWrap } = await import('./wrapper/orchestrator.js');
    return runWrap(argv.slice(1));
  }

  // Detect split subcommand
  if (argv[0] === 'split') {
    return runSplit(argv.slice(1));
  }

  // Detect forge subcommand
  if (argv[0] === 'forge') {
    return runForge(argv.slice(1));
  }

  // Detect expand subcommand
  if (argv[0] === 'expand') {
    return runExpand(argv.slice(1));
  }

  // Detect backfill subcommand
  if (argv[0] === 'backfill') {
    return runBackfill(argv.slice(1));
  }

  // Detect contract subcommand
  if (argv[0] === 'contract') {
    return runContract(argv.slice(1));
  }

  // Detect test subcommand
  if (argv[0] === 'test') {
    return runTest(argv.slice(1));
  }

  // Detect lock subcommand
  if (argv[0] === 'lock') {
    return runLock(argv.slice(1));
  }

  // Detect diff subcommand
  if (argv[0] === 'diff') {
    return runDiff(argv.slice(1));
  }

  // Detect mask subcommand
  if (argv[0] === 'mask') {
    return runMask(argv.slice(1));
  }

  // Detect preflight subcommand (disk capacity & replication lag forecaster)
  if (argv[0] === 'preflight') {
    return runPreflight(argv.slice(1));
  }

  // Detect partition subcommand (declarative partition lifecycle)
  if (argv[0] === 'partition') {
    return runPartition(argv.slice(1));
  }

  // Detect run subcommand (autonomous circuit breaker)
  if (argv[0] === 'run') {
    return runCircuitBreaker(argv.slice(1));
  }

  // Detect top subcommand (deadlock & contention visualizer)
  if (argv[0] === 'top') {
    return runTop(argv.slice(1));
  }

  // Detect doctor subcommand (continuous WAL archival health & disaster recovery readiness)
  if (argv[0] === 'doctor') {
    return runDoctor(argv.slice(1));
  }

  // Detect verify-backup subcommand (restored instance verification & amcheck)
  if (argv[0] === 'verify-backup') {
    return runVerifyBackup(argv.slice(1));
  }

  // Detect compact subcommand (zero-downtime table compaction & bloat estimator)
  if (argv[0] === 'compact') {
    return runCompact(argv.slice(1));
  }

  // Detect tenant subcommand (multi-tenant distribution, state machine & drift auditing)
  if (argv[0] === 'tenant') {
    return runTenant(argv.slice(1));
  }

  // Detect advisor subcommand (autonomous telemetry, hypopg simulation & index pruner)
  if (argv[0] === 'advisor') {
    return runAdvisor(argv.slice(1));
  }

  // Explicit check subcommand (e.g. ddlforge check ...)
  if (argv[0] === 'check') {
    argv = argv.slice(1);
  }

  const options = parseArgs(argv);

  if (options.help) {
    printHelp();
    return 0;
  }

  if (options.version) {
    console.log(`ddlforge v${VERSION}`);
    return 0;
  }

  const files = discoverSqlFiles(options.targets, options.changedOnly);

  if (files.length === 0) {
    let emptyOutput = '';
    if (options.format === 'json') {
      emptyOutput = formatJson([]);
    } else if (options.format === 'markdown') {
      emptyOutput = formatMarkdown([]);
    } else if (options.format === 'sarif') {
      emptyOutput = formatSarif([]);
    } else if (options.format === 'github') {
      emptyOutput = ''; // no annotations needed for empty set
    } else {
      emptyOutput = 'No migration .sql files found to analyze.';
    }

    if (options.output) {
      const outPath = path.isAbsolute(options.output) ? options.output : path.resolve(process.cwd(), options.output);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, emptyOutput, 'utf-8');
    } else {
      console.log(emptyOutput);
    }
    return 0;
  }

  const analyzer = new MigrationAnalyzer();
  const results: AnalysisResult[] = [];

  for (const file of files) {
    try {
      let content = fs.readFileSync(file, 'utf-8');
      let res = analyzer.analyze(content, {
        filePath: file,
        pgVersion: options.pgVersion,
      });

      if (options.fix && res.hasBlockers) {
        const { applyFixes } = await import('./orchestrator/fixer.js');
        const fixResult = applyFixes(content, res.findings);
        if (fixResult.appliedCount > 0) {
          content = fixResult.patchedSql;
          fs.writeFileSync(file, content, 'utf-8');
          console.log(`[ddlforge fix] Successfully applied ${fixResult.appliedCount} safe remediation(s) to "${file}".`);
          // Re-analyze patched content
          res = analyzer.analyze(content, {
            filePath: file,
            pgVersion: options.pgVersion,
          });
        }
      }

      results.push(res);
    } catch (err: any) {
      console.error(`Error reading ${file}: ${err?.message ?? String(err)}`);
    }
  }

  // Format results
  let formattedOutput = '';
  if (options.format === 'json') {
    formattedOutput = formatJson(results);
  } else if (options.format === 'markdown') {
    formattedOutput = formatMarkdown(results);
  } else if (options.format === 'sarif') {
    formattedOutput = formatSarif(results);
  } else if (options.format === 'github') {
    formattedOutput = formatGithub(results);
  } else {
    formattedOutput = formatTerminal(results, { quiet: options.quiet });
  }

  if (options.output) {
    const outPath = path.isAbsolute(options.output) ? options.output : path.resolve(process.cwd(), options.output);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, formattedOutput, 'utf-8');
  } else if (options.format === 'github') {
    // Write workflow commands directly to stdout (bypasses console.log newline buffering)
    process.stdout.write(formattedOutput + (formattedOutput.length > 0 ? '\n' : ''));
  } else {
    console.log(formattedOutput);
  }

  const hasBlockers = results.some(r => r.hasBlockers);
  return hasBlockers ? 1 : 0;
}

/**
 * Executes the `ddlforge apply` subcommand.
 *
 * Imports executor dynamically to preserve zero-dependency
 * invariant for static linting paths.
 */
export async function runApply(argv: string[]): Promise<number> {
  const opts = parseApplyArgs(argv);

  if (opts.help) {
    printHelp();
    return 0;
  }

  if (!opts.file) {
    console.error('ddlforge apply: <file.sql> argument is required.');
    console.error('Usage: ddlforge apply <file.sql> --db <DATABASE_URL>');
    return 1;
  }

  if (!opts.databaseUrl) {
    console.error('ddlforge apply: --db <DATABASE_URL> is required (or set DATABASE_URL env var).');
    return 1;
  }

  const filePath = path.isAbsolute(opts.file)
    ? opts.file
    : path.resolve(process.cwd(), opts.file);

  if (!fs.existsSync(filePath)) {
    console.error(`ddlforge apply: File not found: ${filePath}`);
    return 1;
  }

  const sql = fs.readFileSync(filePath, 'utf-8');

  // Color support
  const useColor = !process.env['NO_COLOR'] && !process.env['NODE_DISABLE_COLORS']
    && (process.env['FORCE_COLOR'] || process.stdout.isTTY);

  const c = {
    reset:   useColor ? '\x1b[0m'    : '',
    bold:    useColor ? '\x1b[1m'    : '',
    dim:     useColor ? '\x1b[2m'    : '',
    red:     useColor ? '\x1b[31m'   : '',
    green:   useColor ? '\x1b[32m'   : '',
    yellow:  useColor ? '\x1b[33m'   : '',
    cyan:    useColor ? '\x1b[36m'   : '',
    gray:    useColor ? '\x1b[90m'   : '',
    bgGreen: useColor ? '\x1b[42m\x1b[30m' : '',
    bgRed:   useColor ? '\x1b[41m\x1b[37m' : '',
  };

  if (opts.dryRun) {
    console.log(`\n${c.cyan}${c.bold}ddlforge apply --dry-run${c.reset} ${c.gray}${filePath}${c.reset}\n`);
  } else {
    console.log(`\n${c.cyan}${c.bold}ddlforge apply${c.reset} ${c.gray}${filePath}${c.reset}`);
    console.log(`${c.dim}  lock_timeout:      ${opts.lockTimeout}${c.reset}`);
    console.log(`${c.dim}  statement_timeout: ${opts.statementTimeout}${c.reset}`);
    console.log(`${c.dim}  max_retries:       ${opts.maxRetries}${c.reset}`);
    console.log(`${c.dim}  queue_threshold:   ${opts.lockQueueThreshold}${c.reset}`);
    console.log('');
  }

  // Dynamic import of executor (pg not in static import graph)
  type ExecutorModule = typeof import('./runner/executor.js');
  const { executeMigration } = await import('./runner/executor.js') as ExecutorModule;

  const startTime = Date.now();

  const result = await executeMigration(sql, {
    databaseUrl:        opts.databaseUrl,
    lockTimeout:        opts.lockTimeout,
    statementTimeout:   opts.statementTimeout,
    maxRetries:         opts.maxRetries,
    dryRun:             opts.dryRun,
    lockQueueThreshold: opts.lockQueueThreshold,
    monitorPollMs:      opts.monitorPollMs,
    onProgress(event) {
      const idx    = event.statementIndex + 1;
      const total  = event.totalStatements;
      const prefix = `  [${String(idx).padStart(String(total).length, ' ')}/${total}]`;
      const snippet = event.statementSql.length > 72
        ? event.statementSql.slice(0, 69) + '...'
        : event.statementSql;

      switch (event.kind) {
        case 'dry-run-statement':
          console.log(`${c.gray}${prefix}${c.reset} ${c.dim}${snippet}${c.reset}`);
          break;
        case 'statement-start':
          process.stdout.write(
            `${c.dim}${prefix}${c.reset} ${snippet} ${c.gray}…${c.reset}`
          );
          break;
        case 'statement-success':
          process.stdout.write(
            `\r${c.green}${prefix}${c.reset} ${snippet} ` +
            `${c.green}✔${c.reset} ${c.gray}(${event.elapsedMs}ms)${c.reset}\n`
          );
          break;
        case 'statement-retry':
          process.stdout.write(
            `\r${c.yellow}${prefix}${c.reset} ${snippet} ` +
            `${c.yellow}↺ retry ${event.attempt}${c.reset} ` +
            `${c.gray}(backoff ${Math.round(event.retryBackoffMs ?? 0)}ms)${c.reset}\n`
          );
          break;
        case 'statement-failed':
          process.stdout.write(
            `\r${c.red}${prefix}${c.reset} ${snippet} ` +
            `${c.red}✖ failed${c.reset}\n`
          );
          if (event.error) {
            console.log(`     ${c.red}${event.error}${c.reset}`);
          }
          break;
        case 'avalanche-abort':
          console.log(`\n  ${c.bgRed} AVALANCHE ABORT ${c.reset} ${c.red}${event.error}${c.reset}\n`);
          break;
        case 'migration-complete':
        case 'migration-failed':
          // handled below after executeMigration returns
          break;
      }
    },
  });

  const elapsed = Date.now() - startTime;

  console.log('');
  console.log(c.gray + '━'.repeat(70) + c.reset);

  if (result.success) {
    console.log(
      `${c.bgGreen} APPLIED ${c.reset} ` +
      `${c.green}${c.bold}${result.statementsExecuted}/${result.statementsTotal} statement(s)${c.reset} ` +
      `executed successfully in ${elapsed}ms`
    );
    return 0;
  } else {
    console.log(
      `${c.bgRed} FAILED ${c.reset} ` +
      `${c.red}${c.bold}${result.statementsExecuted}/${result.statementsTotal} statement(s) applied${c.reset}` +
      (result.error ? `\n  ${c.red}${result.error}${c.reset}` : '')
    );
    return 1;
  }
}

/**
 * Executes the `ddlforge split` subcommand.
 */
export async function runSplit(argv: string[]): Promise<number> {
  let file = '';
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      console.log(`
ddlforge split — Split mixed migration file into phase1_tx and phase2_autocommit

USAGE:
  ddlforge split <file.sql>

ARGUMENTS:
  <file.sql>    Migration SQL file containing mixed transactional and autocommit operations
`);
      return 0;
    }
    if (!arg.startsWith('-') && !file) {
      file = arg;
    }
  }

  if (!file) {
    console.error('ddlforge split: <file.sql> argument is required.');
    console.error('Usage: ddlforge split <file.sql>');
    return 1;
  }

  const fullPath = path.isAbsolute(file) ? file : path.resolve(process.cwd(), file);
  if (!fs.existsSync(fullPath)) {
    console.error(`ddlforge split: File not found: "${file}"`);
    return 1;
  }

  const { splitMigrationFile } = await import('./orchestrator/slicer.js');
  const result = splitMigrationFile(fullPath);

  if (!result) {
    console.warn(`[ddlforge split] Warning: File "${file}" is already clean (no mixed transactional/autocommit statements). No splitting needed.`);
    return 0;
  }

  console.log(`[ddlforge split] Successfully split "${file}" into:`);
  console.log(`  Phase 1 (Transactional): ${result.phase1Path} (${result.result.phase1Transactional.length} statement(s))`);
  console.log(`  Phase 2 (Autocommit):    ${result.phase2Path} (${result.result.phase2Autocommit.length} statement(s))`);
  return 0;
}

/**
 * Executes the `ddlforge forge` subcommand.
 */
export async function runForge(argv: string[]): Promise<number> {
  let orm: 'prisma' | 'drizzle' | undefined;
  let file = '';

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      console.log(`
ddlforge forge — Output ready-to-execute SQL to record completed migration in ORM ledger

USAGE:
  ddlforge forge --orm <prisma|drizzle> <migration-file.sql>

ARGUMENTS:
  <migration-file.sql>    Target migration file to generate ledger record for

FLAGS:
  --orm <type>            Target ORM: prisma | drizzle
`);
      return 0;
    }

    if (arg === '--orm') {
      i++;
      if (i < argv.length) {
        orm = argv[i].toLowerCase() as any;
      }
      i++;
      continue;
    }
    if (arg.startsWith('--orm=')) {
      orm = arg.slice('--orm='.length).toLowerCase() as any;
      i++;
      continue;
    }

    if (!arg.startsWith('-') && !file) {
      file = arg;
    }
    i++;
  }

  if (!file) {
    console.error('ddlforge forge: <migration-file.sql> argument is required.');
    console.error('Usage: ddlforge forge --orm <prisma|drizzle> <migration-file.sql>');
    return 1;
  }

  const fullPath = path.isAbsolute(file) ? file : path.resolve(process.cwd(), file);
  if (!fs.existsSync(fullPath)) {
    console.error(`ddlforge forge: File not found: "${file}"`);
    return 1;
  }

  // Auto-detect ORM if not explicitly specified
  if (!orm) {
    const normalized = fullPath.replace(/\\/g, '/').toLowerCase();
    if (normalized.includes('prisma')) {
      orm = 'prisma';
    } else if (normalized.includes('drizzle')) {
      orm = 'drizzle';
    } else {
      console.error('ddlforge forge: --orm <prisma|drizzle> flag is required.');
      return 1;
    }
  }

  if (orm !== 'prisma' && orm !== 'drizzle') {
    console.error(`ddlforge forge: Unsupported ORM "${orm}". Supported ORMs are: prisma, drizzle.`);
    return 1;
  }

  const { forgeLedger } = await import('./orchestrator/ledger.js');
  const res = forgeLedger(orm, fullPath);
  console.log(res.sql);
  return 0;
}

/**
 * Executes the `ddlforge expand` subcommand.
 */
export async function runExpand(argv: string[]): Promise<number> {
  let file = '';
  let version = 'v2';

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      console.log(`
ddlforge expand — Generate versioned virtual schema with INSTEAD OF triggers

USAGE:
  ddlforge expand <migration-file.sql> --version <v1|v2>

FLAGS:
  --version <v1|v2>    Target schema version tag (default: v2)
`);
      return 0;
    }

    if (arg === '--version') {
      i++;
      if (i < argv.length) version = argv[i];
      i++;
      continue;
    }
    if (arg.startsWith('--version=')) {
      version = arg.slice('--version='.length);
      i++;
      continue;
    }

    if (!arg.startsWith('-') && !file) {
      file = arg;
    }
    i++;
  }

  if (!file) {
    console.error('ddlforge expand: <migration-file.sql> argument is required.');
    console.error('Usage: ddlforge expand <migration-file.sql> --version <v1|v2>');
    return 1;
  }

  const fullPath = path.isAbsolute(file) ? file : path.resolve(process.cwd(), file);
  if (!fs.existsSync(fullPath)) {
    console.error(`ddlforge expand: File not found: "${file}"`);
    return 1;
  }

  const { generateVirtualSchema } = await import('./orchestrator/virtualSchema.js');
  const result = generateVirtualSchema({
    version,
    filePath: fullPath,
  });

  console.log(result.fullSql);
  return 0;
}

/**
 * Executes the `ddlforge backfill` subcommand.
 */
export async function runBackfill(argv: string[]): Promise<number> {
  let table = '';
  let fromCol = '';
  let toCol = '';
  let pk = 'id';
  let batchSize = 5000;

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      console.log(`
ddlforge backfill — Generate resumable keyset pagination backfill procedure

USAGE:
  ddlforge backfill --table <table> --from <col_old> --to <col_new> [--pk <id>]

FLAGS:
  --table <table>       Target table name
  --from <col_old>      Source column name
  --to <col_new>        Target column name
  --pk <id>             Primary key column name (default: id)
  --batch-size <n>      Batch size per transaction commit (default: 5000)
`);
      return 0;
    }

    const nextArg = () => { i++; return i < argv.length ? argv[i] : ''; };

    if (arg === '--table') { table = nextArg(); i++; continue; }
    if (arg.startsWith('--table=')) { table = arg.slice('--table='.length); i++; continue; }

    if (arg === '--from') { fromCol = nextArg(); i++; continue; }
    if (arg.startsWith('--from=')) { fromCol = arg.slice('--from='.length); i++; continue; }

    if (arg === '--to') { toCol = nextArg(); i++; continue; }
    if (arg.startsWith('--to=')) { toCol = arg.slice('--to='.length); i++; continue; }

    if (arg === '--pk') { pk = nextArg(); i++; continue; }
    if (arg.startsWith('--pk=')) { pk = arg.slice('--pk='.length); i++; continue; }

    if (arg === '--batch-size') { batchSize = parseInt(nextArg(), 10) || 5000; i++; continue; }
    if (arg.startsWith('--batch-size=')) { batchSize = parseInt(arg.slice('--batch-size='.length), 10) || 5000; i++; continue; }

    i++;
  }

  if (!table || !fromCol || !toCol) {
    console.error('ddlforge backfill: --table, --from, and --to flags are required.');
    console.error('Usage: ddlforge backfill --table <table> --from <col_old> --to <col_new> [--pk <id>]');
    return 1;
  }

  const { generateBackfillProcedure } = await import('./orchestrator/backfill.js');
  const result = generateBackfillProcedure({
    table,
    fromColumn: fromCol,
    toColumn: toCol,
    primaryKey: pk,
    batchSize,
  });

  console.log(result.fullSql);
  return 0;
}

/**
 * Executes the `ddlforge contract` subcommand.
 */
export async function runContract(argv: string[]): Promise<number> {
  let table = '';
  let column = '';
  let schema = 'public_v1';

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      console.log(`
ddlforge contract — Generate GitLab 3-release zero-downtime teardown script

USAGE:
  ddlforge contract --table <table> --column <legacy_col> [--schema <public_v1>]

FLAGS:
  --table <table>       Target physical table
  --column <legacy_col> Deprecated legacy column to drop
  --schema <public_v1>  Deprecated virtual schema to drop (default: public_v1)
`);
      return 0;
    }

    const nextArg = () => { i++; return i < argv.length ? argv[i] : ''; };

    if (arg === '--table') { table = nextArg(); i++; continue; }
    if (arg.startsWith('--table=')) { table = arg.slice('--table='.length); i++; continue; }

    if (arg === '--column') { column = nextArg(); i++; continue; }
    if (arg.startsWith('--column=')) { column = arg.slice('--column='.length); i++; continue; }

    if (arg === '--schema') { schema = nextArg(); i++; continue; }
    if (arg.startsWith('--schema=')) { schema = arg.slice('--schema='.length); i++; continue; }

    i++;
  }

  if (!table || !column) {
    console.error('ddlforge contract: --table and --column flags are required.');
    console.error('Usage: ddlforge contract --table <table> --column <legacy_col> [--schema <public_v1>]');
    return 1;
  }

  const { generateContractScript } = await import('./orchestrator/contract.js');
  const result = generateContractScript({
    table,
    column,
    schema,
  });

  console.log(result.scriptSql);
  return 0;
}

/**
 * Executes the `ddlforge test` subcommand.
 *
 * Spins up an ephemeral postgres:17-alpine container via Testcontainers,
 * runs one or more migration SQL files against it, and asserts that
 * AccessExclusiveLock hold durations do not exceed --max-lock-ms.
 *
 * Requires DOCKER_AVAILABLE=true to be set, or Docker to be running locally.
 */
export async function runTest(argv: string[]): Promise<number> {
  let files: string[] = [];
  let maxLockMs = 500;
  let image = 'postgres:17-alpine';

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') {
      console.log(`
ddlforge test — Run migrations against ephemeral PostgreSQL container with lock assertion

USAGE:
  ddlforge test [<file.sql>...] [flags]

ARGUMENTS:
  <file.sql>...        One or more migration SQL files to run (default: auto-discover)

FLAGS:
  --max-lock-ms <n>    Maximum AccessExclusiveLock hold time in milliseconds (default: 500)
  --image <image>      PostgreSQL container image (default: postgres:17-alpine)
  --help, -h           Print this help message and exit

ENVIRONMENT:
  DOCKER_AVAILABLE=true          Required to enable real container tests
  TESTCONTAINERS_RYUK_DISABLED   Set to 'true' to disable Ryuk reaper in CI
  DDLFORGE_TEST_PG_IMAGE         Override container image without --image flag

EXAMPLES:
  $ ddlforge test ./migrations/001_add_index.sql
  $ ddlforge test ./prisma/migrations --max-lock-ms 300
  $ DOCKER_AVAILABLE=true ddlforge test ./drizzle --image postgres:16-alpine
`);
      return 0;
    }

    const nextArg = () => { i++; return i < argv.length ? argv[i] : ''; };

    if (arg === '--max-lock-ms') { maxLockMs = parseInt(nextArg(), 10) || 500; i++; continue; }
    if (arg.startsWith('--max-lock-ms=')) { maxLockMs = parseInt(arg.slice('--max-lock-ms='.length), 10) || 500; i++; continue; }

    if (arg === '--image') { image = nextArg(); i++; continue; }
    if (arg.startsWith('--image=')) { image = arg.slice('--image='.length); i++; continue; }

    if (!arg.startsWith('-')) {
      files.push(arg);
    }

    i++;
  }

  // Check Docker availability guard
  if (process.env['DOCKER_AVAILABLE'] !== 'true') {
    console.warn('[ddlforge test] Skipping: DOCKER_AVAILABLE is not set to "true".');
    console.warn('[ddlforge test] Set DOCKER_AVAILABLE=true to enable ephemeral container tests.');
    console.warn('[ddlforge test] This is a safety guard to avoid accidental Docker pulls in non-CI environments.');
    return 0;
  }

  // Discover SQL files if none specified
  if (files.length === 0) {
    files = discoverSqlFiles([], false);
  }

  if (files.length === 0) {
    console.error('[ddlforge test] No migration SQL files found to run.');
    return 1;
  }

  // Resolve and read SQL files
  const migrations: string[] = [];
  for (const file of files) {
    const fullPath = path.isAbsolute(file) ? file : path.resolve(process.cwd(), file);
    if (!fs.existsSync(fullPath)) {
      console.error(`[ddlforge test] File not found: "${file}"`);
      return 1;
    }
    migrations.push(fs.readFileSync(fullPath, 'utf-8'));
  }

  console.log(`[ddlforge test] Starting ephemeral ${image} container...`);
  console.log(`[ddlforge test] Running ${migrations.length} migration(s) with maxLockMs=${maxLockMs}ms`);

  const { runContainerTests } = await import('./harness/testHarness.js');
  const result = await runContainerTests({
    migrations,
    maxLockMs,
    image,
  });

  console.log(result.summary);
  return result.passed ? 0 : 1;
}

/**
 * Executes the `ddlforge lock` subcommand.
 */
export async function runLock(argv: string[]): Promise<number> {
  const sub = argv[0];
  if (!sub || sub === '--help' || sub === '-h') {
    console.log(`
ddlforge lock — Distributed advisory lock clustering inspection and management

USAGE:
  ddlforge lock <status|release> [options]

COMMANDS:
  status      Inspect active and stale advisory locks via pg_locks & ddlforge_run
  release     Release stale advisory locks and clear orphaned runner records

FLAGS:
  --db <url>        PostgreSQL database connection URL (or DATABASE_URL env var)
  --project <name>  Filter by project name
  --force           Force clear runner records even if heartbeat is recent
  --help, -h        Print this help message
`);
    return 0;
  }

  let dbUrl = process.env['DATABASE_URL'] ?? '';
  let project = '';
  let force = false;

  let i = 1;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--db' || arg === '--database-url') {
      i++;
      if (i < argv.length) dbUrl = argv[i];
      i++;
      continue;
    }
    if (arg.startsWith('--db=')) {
      dbUrl = arg.slice('--db='.length);
      i++;
      continue;
    }
    if (arg === '--project') {
      i++;
      if (i < argv.length) project = argv[i];
      i++;
      continue;
    }
    if (arg.startsWith('--project=')) {
      project = arg.slice('--project='.length);
      i++;
      continue;
    }
    if (arg === '--force') {
      force = true;
      i++;
      continue;
    }
    i++;
  }

  if (!dbUrl) {
    console.error('ddlforge lock: --db <url> is required (or set DATABASE_URL env var).');
    return 1;
  }

  const { Client } = await import('pg');
  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  try {
    const { DistributedLockManager } = await import('./cluster/advisory.js');
    const lockMgr = new DistributedLockManager({ project: project || 'default' });

    if (sub === 'status') {
      const report = await lockMgr.getLockStatus(client, project || undefined);
      console.log(`\n=== ddlforge Distributed Lock Status ===`);
      console.log(`Active locks: ${report.activeCount}, Stale locks: ${report.staleCount}\n`);
      if (report.records.length === 0) {
        console.log('No active ddlforge advisory locks found.');
      } else {
        for (const r of report.records) {
          const statusBadge = r.isStale ? '[STALE]' : '[ACTIVE]';
          console.log(`${statusBadge} Namespace: "${r.lockNamespace}" (Key: ${r.lockKey})`);
          console.log(`   Runner: ${r.runnerId}, PID: ${r.pid}, App: ${r.applicationName ?? 'none'}`);
          console.log(`   Acquired: ${r.acquiredAt.toISOString()}, Heartbeat: ${r.lastHeartbeat.toISOString()}`);
          console.log(`   Backend alive: ${r.isBackendAlive ? 'yes' : 'no'}\n`);
        }
      }
      return 0;
    }

    if (sub === 'release') {
      const report = await lockMgr.releaseStaleLocks(client, { project: project || undefined, force });
      console.log(`\n=== ddlforge Distributed Lock Release ===`);
      console.log(`Cleared records: ${report.clearedCount}, Unlocked sessions: ${report.unlockedCount}`);
      for (const d of report.details) {
        console.log(`  ✔ ${d}`);
      }
      return 0;
    }

    console.error(`ddlforge lock: Unknown subcommand "${sub}". Supported subcommands: status, release.`);
    return 1;
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * Executes the `ddlforge diff` subcommand.
 */
export async function runDiff(argv: string[]): Promise<number> {
  let dbUrl = process.env['DATABASE_URL'] ?? '';
  let dir = '';
  let format: 'terminal' | 'json' = 'terminal';
  let schema = 'public';
  const targets: string[] = [];

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      console.log(`
ddlforge diff — Live schema drift introspection and AST comparison

USAGE:
  ddlforge diff [options] [<files...>]

FLAGS:
  --db <url>        PostgreSQL database connection URL (or DATABASE_URL env var)
  --dir <path>      Directory containing target migration SQL files
  --schema <name>   PostgreSQL schema to introspect (default: public)
  --format <type>   Output format: terminal | json (default: terminal)
  --help, -h        Print this help message

EXAMPLES:
  $ ddlforge diff --db postgres://localhost/mydb
  $ ddlforge diff --dir ./prisma/migrations --format json
  $ ddlforge diff ./migrations/001_init.sql --db postgres://localhost/mydb
`);
      return 0;
    }

    const nextArg = () => { i++; return i < argv.length ? argv[i] : ''; };

    if (arg === '--db' || arg === '--database-url') { dbUrl = nextArg(); i++; continue; }
    if (arg.startsWith('--db=')) { dbUrl = arg.slice('--db='.length); i++; continue; }

    if (arg === '--dir') { dir = nextArg(); i++; continue; }
    if (arg.startsWith('--dir=')) { dir = arg.slice('--dir='.length); i++; continue; }

    if (arg === '--schema') { schema = nextArg(); i++; continue; }
    if (arg.startsWith('--schema=')) { schema = arg.slice('--schema='.length); i++; continue; }

    if (arg === '--format') {
      const f = nextArg().toLowerCase();
      if (f === 'json' || f === 'terminal') format = f;
      i++;
      continue;
    }
    if (arg.startsWith('--format=')) {
      const f = arg.slice('--format='.length).toLowerCase();
      if (f === 'json' || f === 'terminal') format = f;
      i++;
      continue;
    }

    if (!arg.startsWith('-')) {
      targets.push(arg);
    }

    i++;
  }

  if (!dbUrl) {
    console.error('ddlforge diff: --db <url> is required (or set DATABASE_URL env var).');
    return 1;
  }

  // Find target SQL files
  const searchTargets = targets.length > 0 ? targets : (dir ? [dir] : []);
  const files = discoverSqlFiles(searchTargets, false);

  if (files.length === 0) {
    console.error('ddlforge diff: No target migration SQL files found to compare against.');
    return 1;
  }

  let concatenatedSql = '';
  for (const f of files) {
    concatenatedSql += '\n' + fs.readFileSync(f, 'utf-8');
  }

  const { Client } = await import('pg');
  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  try {
    const { introspectCatalog } = await import('./diff/catalog.js');
    const { catalogToSchemaGraph, buildSchemaGraphFromSql, compareSchemas, formatDiffTerminal, formatDiffJson } = await import('./diff/comparator.js');

    const catalog = await introspectCatalog(client, { schemas: [schema] });
    const liveGraph = catalogToSchemaGraph(catalog);
    const targetGraph = buildSchemaGraphFromSql(concatenatedSql);

    const diff = compareSchemas(liveGraph, targetGraph);

    if (format === 'json') {
      console.log(formatDiffJson(diff));
    } else {
      console.log(formatDiffTerminal(diff));
    }

    return diff.hasUnsafe ? 1 : 0;
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * Executes the `ddlforge mask` subcommand.
 */
export async function runMask(argv: string[]): Promise<number> {
  const sub = argv[0];
  if (!sub || sub === '--help' || sub === '-h') {
    console.log(`
ddlforge mask — Native In-Flight Data Masking and Zero-Downtime PII Anonymization

USAGE:
  ddlforge mask trigger --table <table> --columns <col:type,...> [options]
  ddlforge mask backfill --table <table> --columns <col:type,...> [options]
  ddlforge mask advice --table <table> [options]

SUBCOMMANDS:
  trigger     Generate BEFORE ROW in-memory trigger and cryptographic helper functions
  backfill    Generate keyset-paginated resumable backfill procedure with loop commits
  advice      Emit storage (fillfactor/HOT), logging (track_utility), and verification checklist

FLAGS:
  --table <table>     Target physical table name (required)
  --columns <specs>   Comma-separated list of column:type specifications (e.g. email:email,user_id:integer)
  --pk <id>           Primary key column name for keyset backfill (default: id)
  --batch-size <n>    Batch size per transaction commit for backfill (default: 2500)
  --schema <name>     PostgreSQL schema name (default: public)
  --fillfactor <n>    Recommended fillfactor for HOT updates (default: 85)
  --format <type>     Output format for advice: terminal | json (default: terminal)
  --salt-guc <name>   Session GUC variable storing the masking salt (default: app.masking_salt)
  --help, -h          Print this help message
`);
    return 0;
  }

  let table = '';
  let columnsStr = '';
  let pk = 'id';
  let batchSize = 2500;
  let schema = 'public';
  let fillfactor = 85;
  let format: 'terminal' | 'json' = 'terminal';
  let saltGuc = 'app.masking_salt';

  let i = 1;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      return runMask(['--help']);
    }

    const nextArg = () => { i++; return i < argv.length ? argv[i] : ''; };

    if (arg === '--table') { table = nextArg(); i++; continue; }
    if (arg.startsWith('--table=')) { table = arg.slice('--table='.length); i++; continue; }

    if (arg === '--columns') { columnsStr = nextArg(); i++; continue; }
    if (arg.startsWith('--columns=')) { columnsStr = arg.slice('--columns='.length); i++; continue; }

    if (arg === '--pk') { pk = nextArg(); i++; continue; }
    if (arg.startsWith('--pk=')) { pk = arg.slice('--pk='.length); i++; continue; }

    if (arg === '--batch-size') { batchSize = parseInt(nextArg(), 10) || 2500; i++; continue; }
    if (arg.startsWith('--batch-size=')) { batchSize = parseInt(arg.slice('--batch-size='.length), 10) || 2500; i++; continue; }

    if (arg === '--schema') { schema = nextArg(); i++; continue; }
    if (arg.startsWith('--schema=')) { schema = arg.slice('--schema='.length); i++; continue; }

    if (arg === '--fillfactor') { fillfactor = parseInt(nextArg(), 10) || 85; i++; continue; }
    if (arg.startsWith('--fillfactor=')) { fillfactor = parseInt(arg.slice('--fillfactor='.length), 10) || 85; i++; continue; }

    if (arg === '--salt-guc') { saltGuc = nextArg(); i++; continue; }
    if (arg.startsWith('--salt-guc=')) { saltGuc = arg.slice('--salt-guc='.length); i++; continue; }

    if (arg === '--format') {
      const f = nextArg().toLowerCase();
      if (f === 'json' || f === 'terminal') format = f;
      i++;
      continue;
    }
    if (arg.startsWith('--format=')) {
      const f = arg.slice('--format='.length).toLowerCase();
      if (f === 'json' || f === 'terminal') format = f;
      i++;
      continue;
    }

    i++;
  }

  if (!table) {
    console.error('ddlforge mask: --table <table> flag is required.');
    return 1;
  }

  const columns = columnsStr
    ? columnsStr.split(',').map(s => s.trim()).filter(Boolean)
    : [];

  if (sub === 'trigger') {
    if (columns.length === 0) {
      console.error('ddlforge mask trigger: --columns <col:type,...> flag is required.');
      return 1;
    }
    const { generateMaskingTrigger } = await import('./masking/triggers.js');
    const res = generateMaskingTrigger({
      table,
      columns,
      schema,
      saltGuc,
    });
    console.log(res.fullSql);
    return 0;
  }

  if (sub === 'backfill') {
    if (columns.length === 0) {
      console.error('ddlforge mask backfill: --columns <col:type,...> flag is required.');
      return 1;
    }
    const { generateMaskingBackfill } = await import('./masking/backfill.js');
    const res = generateMaskingBackfill({
      table,
      columns,
      primaryKey: pk,
      batchSize,
      schema,
      saltGuc,
    });
    console.log(res.fullSql);
    return 0;
  }

  if (sub === 'advice') {
    const { generateMaskingAdvice, formatMaskingAdviceTerminal, formatMaskingAdviceJson } = await import('./masking/advisor.js');
    const report = generateMaskingAdvice({
      table,
      schema,
      columns,
      recommendedFillfactor: fillfactor,
      saltGuc,
    });
    if (format === 'json') {
      console.log(formatMaskingAdviceJson(report));
    } else {
      console.log(formatMaskingAdviceTerminal(report));
    }
    return 0;
  }

  console.error(`ddlforge mask: Unknown subcommand "${sub}". Supported subcommands: trigger, backfill, advice.`);
  return 1;
}

/**
 * Executes the `ddlforge run` subcommand.
 */
export async function runCircuitBreaker(argv: string[]): Promise<number> {
  let file = '';
  let dbUrl = process.env['DATABASE_URL'] ?? '';
  let maxQueueDepth = 5;
  let maxQueueWaitMs = 200;
  let retries = 50;
  let baseDelayMs = 100;
  let capDelayMs = 5000;
  let forceNoBackup = false;
  let rpoHours = 24;
  let backupProvider = 'catalog';
  let skipDrGuard = false;

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') {
      console.log(`
ddlforge run <file.sql> --db <url> [options]

Execute a migration with autonomous lock pre-emption and decorrelated jitter.

ARGUMENTS:
  <file.sql>          Migration SQL file to execute

FLAGS:
  --db <url>          PostgreSQL connection URL (required, defaults to DATABASE_URL)
  --max-queue <n>     Maximum blocked queries before pre-emption trip (default: 5)
  --max-wait-ms <n>   Maximum wait time in ms before pre-emption trip (default: 200)
  --retries <n>       Maximum retry attempts with decorrelated jitter (default: 50)
  --base-delay-ms <n> Initial base delay in ms for backoff (default: 100)
  --cap-delay-ms <n>  Maximum delay cap in ms for backoff (default: 5000)
  --force-no-backup   Bypass disaster recovery and backup RPO safety guard
  --rpo-hours <n>     Maximum acceptable backup age in hours (default: 24)
  --backup-provider <p> Backup auditor provider: catalog | pgbackrest | mock (default: catalog)
  --skip-dr-guard     Skip continuous archiving and replication slot checks
  --help, -h          Print this help message and exit
`);
      return 0;
    }

    if (arg === '--db') {
      i++;
      if (i < argv.length) dbUrl = argv[i];
      i++;
      continue;
    }
    if (arg.startsWith('--db=')) {
      dbUrl = arg.slice('--db='.length);
      i++;
      continue;
    }

    if (arg === '--max-queue') {
      i++;
      if (i < argv.length) maxQueueDepth = parseInt(argv[i], 10) || 5;
      i++;
      continue;
    }
    if (arg.startsWith('--max-queue=')) {
      maxQueueDepth = parseInt(arg.slice('--max-queue='.length), 10) || 5;
      i++;
      continue;
    }

    if (arg === '--max-wait-ms') {
      i++;
      if (i < argv.length) maxQueueWaitMs = parseInt(argv[i], 10) || 200;
      i++;
      continue;
    }
    if (arg.startsWith('--max-wait-ms=')) {
      maxQueueWaitMs = parseInt(arg.slice('--max-wait-ms='.length), 10) || 200;
      i++;
      continue;
    }

    if (arg === '--retries') {
      i++;
      if (i < argv.length) retries = parseInt(argv[i], 10) || 50;
      i++;
      continue;
    }
    if (arg.startsWith('--retries=')) {
      retries = parseInt(arg.slice('--retries='.length), 10) || 50;
      i++;
      continue;
    }

    if (arg === '--base-delay-ms') {
      i++;
      if (i < argv.length) baseDelayMs = parseInt(argv[i], 10) || 100;
      i++;
      continue;
    }
    if (arg.startsWith('--base-delay-ms=')) {
      baseDelayMs = parseInt(arg.slice('--base-delay-ms='.length), 10) || 100;
      i++;
      continue;
    }

    if (arg === '--cap-delay-ms') {
      i++;
      if (i < argv.length) capDelayMs = parseInt(argv[i], 10) || 5000;
      i++;
      continue;
    }
    if (arg.startsWith('--cap-delay-ms=')) {
      capDelayMs = parseInt(arg.slice('--cap-delay-ms='.length), 10) || 5000;
      i++;
      continue;
    }

    if (arg === '--force-no-backup') {
      forceNoBackup = true;
      i++;
      continue;
    }

    if (arg === '--rpo-hours') {
      i++;
      if (i < argv.length) rpoHours = parseInt(argv[i], 10) || 24;
      i++;
      continue;
    }
    if (arg.startsWith('--rpo-hours=')) {
      rpoHours = parseInt(arg.slice('--rpo-hours='.length), 10) || 24;
      i++;
      continue;
    }

    if (arg === '--backup-provider') {
      i++;
      if (i < argv.length) backupProvider = argv[i];
      i++;
      continue;
    }
    if (arg.startsWith('--backup-provider=')) {
      backupProvider = arg.slice('--backup-provider='.length);
      i++;
      continue;
    }

    if (arg === '--skip-dr-guard') {
      skipDrGuard = true;
      i++;
      continue;
    }

    if (!arg.startsWith('-') && !file) {
      file = arg;
      i++;
      continue;
    }

    i++;
  }

  if (!file) {
    console.error('ddlforge run: Missing migration SQL file argument.');
    return 1;
  }

  const resolvedPath = path.resolve(process.cwd(), file);
  if (!fs.existsSync(resolvedPath)) {
    console.error(`ddlforge run: Migration file not found: ${file}`);
    return 1;
  }

  if (!dbUrl) {
    console.error('ddlforge run: Missing required database connection URL (--db or DATABASE_URL).');
    return 1;
  }

  const ddlSql = fs.readFileSync(resolvedPath, 'utf-8');

  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: dbUrl });

  try {
    // Disaster Recovery & Backup RPO Safety Guard for high-risk migrations
    const { detectHighRiskOperations, auditDisasterReadiness, auditBackupRpo, recordSafetyLog } =
      await import('./recovery/index.js');
    const risk = detectHighRiskOperations(ddlSql);

    if (risk.isHighRisk && !skipDrGuard) {
      let disasterReport: any = null;
      let backupReport: any = null;

      try {
        disasterReport = await auditDisasterReadiness(pool);
      } catch (err: any) {
        console.warn(`[ddlforge run] Warning: Disaster readiness query notice: ${err.message}`);
      }

      try {
        backupReport = await auditBackupRpo(backupProvider as any, pool, { rpoHours });
      } catch (err: any) {
        console.warn(`[ddlforge run] Warning: Backup RPO audit notice: ${err.message}`);
      }

      const isArchiverFailing = disasterReport?.archiver?.status === 'FAILING_NOW';
      const isRpoViolated = backupReport && !backupReport.isCompliant;

      if ((isArchiverFailing || isRpoViolated) && !forceNoBackup) {
        await recordSafetyLog(pool, {
          eventType: 'migration_preflight',
          targetIdentifier: dbUrl.replace(/:[^:@]+@/, ':***@'),
          status: 'FAILED',
          details: {
            file,
            reasons: risk.reasons,
            archiverStatus: disasterReport?.archiver?.status,
            rpoCompliant: backupReport?.isCompliant,
            violationReason: backupReport?.violationReason,
          },
        });

        console.error(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✖ HIGH-RISK MIGRATION BLOCKED: DISASTER RECOVERY & RPO SAFETY GUARD
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Detected destructive/irreversible DDL operations in ${file}:
${risk.reasons.map((r: string) => `  - ${r}`).join('\n')}

SAFETY VIOLATIONS:`);

        if (isArchiverFailing) {
          console.error(`  - FAILING WAL ARCHIVE: pg_stat_archiver shows active archive failures. Point-in-time recovery is broken.`);
        }
        if (isRpoViolated) {
          console.error(`  - RPO THRESHOLD EXCEEDED: ${backupReport?.violationReason ?? `Backup older than ${rpoHours}h limit.`}`);
        }

        console.error(`
DIAGNOSTIC & REMEDIATION STEPS:
  1. Inspect PostgreSQL WAL archiving: SELECT * FROM pg_stat_archiver;
  2. Verify or trigger a fresh backup before executing destructive migrations.
  3. Run 'ddlforge doctor --db <url>' to check cluster recovery readiness.
  4. To bypass this guard for testing or emergency maintenance, pass --force-no-backup.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
        return 1;
      }

      if (disasterReport || backupReport) {
        await recordSafetyLog(pool, {
          eventType: 'migration_preflight',
          targetIdentifier: dbUrl.replace(/:[^:@]+@/, ':***@'),
          status: 'PASSED',
          details: {
            file,
            reasons: risk.reasons,
            archiverStatus: disasterReport?.archiver?.status,
            rpoCompliant: backupReport?.isCompliant,
          },
        });
      }
    }

    const { MigrationCircuitBreaker } = await import('./cluster/circuitBreaker.js');
    const breaker = new MigrationCircuitBreaker({
      maxQueueDepth,
      maxQueueWaitMs,
    });


    breaker.on('tripped', (evt) => {
      console.warn(`[ddlforge circuit breaker] Pre-emptively canceled DDL (PID ${evt.executorPid}) - ${evt.queueDepth} queries blocked, max wait ${evt.maxWaitMs}ms (attempt ${evt.attempt})`);
    });

    breaker.on('retry', (evt) => {
      console.log(`[ddlforge circuit breaker] Retrying in ${evt.sleepMs}ms (attempt ${evt.attempt}, reason: ${evt.reason})...`);
    });

    breaker.on('success', (evt) => {
      console.log(`✔ Migration executed successfully in ${evt.durationMs}ms (${evt.attempts} attempt${evt.attempts > 1 ? 's' : ''})`);
    });

    const result = await breaker.executeWithPreemption(pool, ddlSql, {
      maxRetries: retries,
      baseDelayMs,
      capDelayMs,
    });

    return result.success ? 0 : 1;
  } catch (err: any) {
    console.error(`ddlforge run: Migration execution failed: ${err.message}`);
    return 1;
  } finally {
    await pool.end().catch(() => {});
  }
}

/**
 * Executes the `ddlforge top` subcommand.
 */
export async function runTop(argv: string[]): Promise<number> {
  let dbUrl = process.env['DATABASE_URL'] ?? '';
  let format: 'terminal' | 'json' = 'terminal';
  let watch = false;

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      console.log(`
ddlforge top --db <url> [options]

Real-time lock contention & deadlock graph visualizer.

FLAGS:
  --db <url>          PostgreSQL connection URL (defaults to DATABASE_URL)
  --format <type>     Output format: terminal | json (default: terminal)
  --watch             Continuously refresh lock contention graph every 1s
  --help, -h          Print this help message and exit
`);
      return 0;
    }
    if (arg === '--watch') {
      watch = true;
      i++;
      continue;
    }
    if (arg === '--db') {
      i++;
      if (i < argv.length) dbUrl = argv[i];
      i++;
      continue;
    }
    if (arg.startsWith('--db=')) {
      dbUrl = arg.slice('--db='.length);
      i++;
      continue;
    }
    if (arg === '--format') {
      i++;
      if (i < argv.length) {
        const f = argv[i].toLowerCase();
        if (f === 'json' || f === 'terminal') format = f;
      }
      i++;
      continue;
    }
    if (arg.startsWith('--format=')) {
      const f = arg.slice('--format='.length).toLowerCase();
      if (f === 'json' || f === 'terminal') format = f;
      i++;
      continue;
    }
    i++;
  }

  if (!dbUrl) {
    console.error('ddlforge top: Missing required database connection URL (--db or DATABASE_URL).');
    return 1;
  }

  const { Client } = await import('pg');
  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  try {
    const { fetchLiveDeadlockGraph, formatDeadlockGraphTerminal, formatDeadlockGraphJson } = await import('./cluster/deadlockGraph.js');

    const printOnce = async () => {
      const graph = await fetchLiveDeadlockGraph(client);
      if (format === 'json') {
        console.log(formatDeadlockGraphJson(graph));
      } else {
        console.log(formatDeadlockGraphTerminal(graph));
      }
    };

    if (!watch) {
      await printOnce();
      return 0;
    }

    // Watch mode: loop every 1000ms until SIGINT / process exit
    while (true) {
      if (format === 'terminal') {
        // Clear terminal screen
        process.stdout.write('\x1b[2J\x1b[0;0H');
      }
      await printOnce();
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * Executes the `ddlforge partition` subcommand.
 */
export async function runPartition(argv: string[]): Promise<number> {
  const sub = argv[0];

  if (!sub || sub === '--help' || sub === '-h') {
    console.log(`
ddlforge partition <convert|attach|detach|maintenance> [options]

Declarative Partition Lifecycle, Online Conversion, and Safe Attachment/Detachment.

SUBCOMMANDS:
  convert             Generate zero-downtime 4-phase monolithic table conversion script
  attach              Generate safe scan-skipping partition attachment script (3-phase)
  detach              Generate safe autocommit-safe partition detachment script
  maintenance         Generate rolling forward pre-allocation and retention pruning procedure

FLAGS:
  --help, -h          Print this help message and exit

Run "ddlforge partition <subcommand> --help" for detailed options.
`);
    return 0;
  }

  // Handle convert
  if (sub === 'convert') {
    let table = '';
    let key = '';
    let type: 'range' | 'list' = 'range';
    let pk = 'id';
    let batchSize = 5000;
    let throttleMs = 50;
    let schema = 'public';
    let shadowTable = '';
    let archiveTable = '';
    let viewName = '';

    let i = 1;
    while (i < argv.length) {
      const arg = argv[i];
      if (arg === '--help' || arg === '-h') {
        console.log(`
ddlforge partition convert --table <table> --key <column> [options]

Generate zero-downtime 4-phase monolithic table conversion SQL.

FLAGS:
  --table <table>     Monolithic table name to convert (required)
  --key <column>      Partition key column (required)
  --type <range|list> Partition strategy: range | list (default: range)
  --pk <col>          Primary key column for keyset backfill (default: id)
  --batch-size <n>    Backfill batch size per commit (default: 5000)
  --throttle-ms <n>   Jittered sleep throttle between batches in ms (default: 50)
  --schema <name>     Target PostgreSQL schema (default: public)
  --shadow-table <t>  Shadow partitioned table name (default: <table_name>_parted)
  --archive-table <t> Legacy archive table name (default: <table_name>_legacy)
  --view-name <v>     Updatable view abstraction name (default: <table_name>_view)
  --help, -h          Print this help message and exit
`);
        return 0;
      }
      if (arg === '--table') {
        i++;
        if (i < argv.length) table = argv[i];
        i++;
        continue;
      }
      if (arg.startsWith('--table=')) {
        table = arg.slice('--table='.length);
        i++;
        continue;
      }
      if (arg === '--key') {
        i++;
        if (i < argv.length) key = argv[i];
        i++;
        continue;
      }
      if (arg.startsWith('--key=')) {
        key = arg.slice('--key='.length);
        i++;
        continue;
      }
      if (arg === '--type') {
        i++;
        if (i < argv.length) {
          const t = argv[i].toLowerCase();
          if (t === 'range' || t === 'list') type = t;
        }
        i++;
        continue;
      }
      if (arg.startsWith('--type=')) {
        const t = arg.slice('--type='.length).toLowerCase();
        if (t === 'range' || t === 'list') type = t;
        i++;
        continue;
      }
      if (arg === '--pk') {
        i++;
        if (i < argv.length) pk = argv[i];
        i++;
        continue;
      }
      if (arg.startsWith('--pk=')) {
        pk = arg.slice('--pk='.length);
        i++;
        continue;
      }
      if (arg === '--batch-size') {
        i++;
        if (i < argv.length) batchSize = parseInt(argv[i], 10) || 5000;
        i++;
        continue;
      }
      if (arg.startsWith('--batch-size=')) {
        batchSize = parseInt(arg.slice('--batch-size='.length), 10) || 5000;
        i++;
        continue;
      }
      if (arg === '--throttle-ms') {
        i++;
        if (i < argv.length) throttleMs = parseInt(argv[i], 10) || 50;
        i++;
        continue;
      }
      if (arg.startsWith('--throttle-ms=')) {
        throttleMs = parseInt(arg.slice('--throttle-ms='.length), 10) || 50;
        i++;
        continue;
      }
      if (arg === '--schema') {
        i++;
        if (i < argv.length) schema = argv[i];
        i++;
        continue;
      }
      if (arg.startsWith('--schema=')) {
        schema = arg.slice('--schema='.length);
        i++;
        continue;
      }
      if (arg === '--shadow-table') {
        i++;
        if (i < argv.length) shadowTable = argv[i];
        i++;
        continue;
      }
      if (arg.startsWith('--shadow-table=')) {
        shadowTable = arg.slice('--shadow-table='.length);
        i++;
        continue;
      }
      if (arg === '--archive-table') {
        i++;
        if (i < argv.length) archiveTable = argv[i];
        i++;
        continue;
      }
      if (arg.startsWith('--archive-table=')) {
        archiveTable = arg.slice('--archive-table='.length);
        i++;
        continue;
      }
      if (arg === '--view-name') {
        i++;
        if (i < argv.length) viewName = argv[i];
        i++;
        continue;
      }
      if (arg.startsWith('--view-name=')) {
        viewName = arg.slice('--view-name='.length);
        i++;
        continue;
      }
      i++;
    }

    if (!table) {
      console.error('ddlforge partition convert: --table <table> flag is required.');
      return 1;
    }
    if (!key) {
      console.error('ddlforge partition convert: --key <column> flag is required.');
      return 1;
    }

    const { generatePartitionConversion } = await import('./partition/convert.js');
    const result = generatePartitionConversion({
      table,
      key,
      type,
      primaryKey: pk,
      batchSize,
      throttleMs,
      schema,
      shadowTable: shadowTable || undefined,
      archiveTable: archiveTable || undefined,
      viewName: viewName || undefined,
    });
    console.log(result.fullSql);
    return 0;
  }

  // Handle attach
  if (sub === 'attach') {
    let parent = '';
    let partition = '';
    let fromVal: string | number = '';
    let toVal: string | number = '';
    let key = '';
    let schema = 'public';
    let constraintName = '';

    let i = 1;
    while (i < argv.length) {
      const arg = argv[i];
      if (arg === '--help' || arg === '-h') {
        console.log(`
ddlforge partition attach --parent <tbl> --partition <part> --from <val> --to <val> [options]

Generate safe 3-phase scan-skipping partition attachment SQL.

FLAGS:
  --parent <tbl>      Parent partitioned table name (required)
  --partition <part>  Partition table name to attach (required)
  --from <val>        Lower partition boundary value (required)
  --to <val>          Upper partition boundary value (required)
  --key <col>         Partition key column name (default: created_at)
  --schema <name>     Target PostgreSQL schema (default: public)
  --constraint-name <name> Boundary CHECK constraint name (default: <part>_bnd_chk)
  --help, -h          Print this help message and exit
`);
        return 0;
      }
      if (arg === '--parent') {
        i++;
        if (i < argv.length) parent = argv[i];
        i++;
        continue;
      }
      if (arg.startsWith('--parent=')) {
        parent = arg.slice('--parent='.length);
        i++;
        continue;
      }
      if (arg === '--partition') {
        i++;
        if (i < argv.length) partition = argv[i];
        i++;
        continue;
      }
      if (arg.startsWith('--partition=')) {
        partition = arg.slice('--partition='.length);
        i++;
        continue;
      }
      if (arg === '--from') {
        i++;
        if (i < argv.length) fromVal = argv[i];
        i++;
        continue;
      }
      if (arg.startsWith('--from=')) {
        fromVal = arg.slice('--from='.length);
        i++;
        continue;
      }
      if (arg === '--to') {
        i++;
        if (i < argv.length) toVal = argv[i];
        i++;
        continue;
      }
      if (arg.startsWith('--to=')) {
        toVal = arg.slice('--to='.length);
        i++;
        continue;
      }
      if (arg === '--key') {
        i++;
        if (i < argv.length) key = argv[i];
        i++;
        continue;
      }
      if (arg.startsWith('--key=')) {
        key = arg.slice('--key='.length);
        i++;
        continue;
      }
      if (arg === '--schema') {
        i++;
        if (i < argv.length) schema = argv[i];
        i++;
        continue;
      }
      if (arg.startsWith('--schema=')) {
        schema = arg.slice('--schema='.length);
        i++;
        continue;
      }
      if (arg === '--constraint-name') {
        i++;
        if (i < argv.length) constraintName = argv[i];
        i++;
        continue;
      }
      if (arg.startsWith('--constraint-name=')) {
        constraintName = arg.slice('--constraint-name='.length);
        i++;
        continue;
      }
      i++;
    }

    if (!parent) {
      console.error('ddlforge partition attach: --parent <tbl> flag is required.');
      return 1;
    }
    if (!partition) {
      console.error('ddlforge partition attach: --partition <part> flag is required.');
      return 1;
    }
    if (fromVal === '') {
      console.error('ddlforge partition attach: --from <val> flag is required.');
      return 1;
    }
    if (toVal === '') {
      console.error('ddlforge partition attach: --to <val> flag is required.');
      return 1;
    }

    const { generatePartitionAttachment } = await import('./partition/attach.js');
    const result = generatePartitionAttachment({
      parent,
      partition,
      from: fromVal,
      to: toVal,
      key: key || undefined,
      schema,
      constraintName: constraintName || undefined,
    });
    console.log(result.fullSql);
    return 0;
  }

  // Handle detach
  if (sub === 'detach') {
    let parent = '';
    let partition = '';
    let concurrent = true;
    let schema = 'public';

    let i = 1;
    while (i < argv.length) {
      const arg = argv[i];
      if (arg === '--help' || arg === '-h') {
        console.log(`
ddlforge partition detach --parent <tbl> --partition <part> [--concurrent] [options]

Generate safe partition detachment SQL with PG14-PG16 FK anomaly remediation.

FLAGS:
  --parent <tbl>      Parent partitioned table name (required)
  --partition <part>  Partition table name to detach (required)
  --concurrent        Execute concurrent autocommit detachment (default: true)
  --no-concurrent     Execute standard non-concurrent detachment
  --schema <name>     Target PostgreSQL schema (default: public)
  --help, -h          Print this help message and exit
`);
        return 0;
      }
      if (arg === '--parent') {
        i++;
        if (i < argv.length) parent = argv[i];
        i++;
        continue;
      }
      if (arg.startsWith('--parent=')) {
        parent = arg.slice('--parent='.length);
        i++;
        continue;
      }
      if (arg === '--partition') {
        i++;
        if (i < argv.length) partition = argv[i];
        i++;
        continue;
      }
      if (arg.startsWith('--partition=')) {
        partition = arg.slice('--partition='.length);
        i++;
        continue;
      }
      if (arg === '--concurrent') {
        concurrent = true;
        i++;
        continue;
      }
      if (arg === '--no-concurrent') {
        concurrent = false;
        i++;
        continue;
      }
      if (arg === '--schema') {
        i++;
        if (i < argv.length) schema = argv[i];
        i++;
        continue;
      }
      if (arg.startsWith('--schema=')) {
        schema = arg.slice('--schema='.length);
        i++;
        continue;
      }
      i++;
    }

    if (!parent) {
      console.error('ddlforge partition detach: --parent <tbl> flag is required.');
      return 1;
    }
    if (!partition) {
      console.error('ddlforge partition detach: --partition <part> flag is required.');
      return 1;
    }

    const { generatePartitionDetachment } = await import('./partition/detach.js');
    const result = generatePartitionDetachment({
      parent,
      partition,
      concurrent,
      schema,
    });
    console.log(result.fullSql);
    return 0;
  }

  // Handle maintenance
  if (sub === 'maintenance') {
    let parent = '';
    let interval: 'monthly' | 'daily' = 'monthly';
    let premake = 3;
    let retention = 12;
    let schema = 'public';
    let key = 'created_at';
    let procedureName = '';
    let lockTimeout = '2s';

    let i = 1;
    while (i < argv.length) {
      const arg = argv[i];
      if (arg === '--help' || arg === '-h') {
        console.log(`
ddlforge partition maintenance --parent <tbl> [options]

Generate automated rolling partition maintenance procedure.

FLAGS:
  --parent <tbl>      Parent partitioned table name (required)
  --interval <type>   Partition interval: monthly | daily (default: monthly)
  --premake <n>       Number of future partitions to pre-allocate (default: 3)
  --retention <n>     Number of intervals before detachment (default: 12)
  --key <col>         Partition key column (default: created_at)
  --schema <name>     Target PostgreSQL schema (default: public)
  --procedure <name>  Custom stored procedure name
  --lock-timeout <t>  Bounded lock timeout during maintenance (default: 2s)
  --help, -h          Print this help message and exit
`);
        return 0;
      }
      if (arg === '--parent') {
        i++;
        if (i < argv.length) parent = argv[i];
        i++;
        continue;
      }
      if (arg.startsWith('--parent=')) {
        parent = arg.slice('--parent='.length);
        i++;
        continue;
      }
      if (arg === '--interval') {
        i++;
        if (i < argv.length) {
          const inv = argv[i].toLowerCase();
          if (inv === 'monthly' || inv === 'daily') interval = inv;
        }
        i++;
        continue;
      }
      if (arg.startsWith('--interval=')) {
        const inv = arg.slice('--interval='.length).toLowerCase();
        if (inv === 'monthly' || inv === 'daily') interval = inv;
        i++;
        continue;
      }
      if (arg === '--premake') {
        i++;
        if (i < argv.length) premake = parseInt(argv[i], 10) || 3;
        i++;
        continue;
      }
      if (arg.startsWith('--premake=')) {
        premake = parseInt(arg.slice('--premake='.length), 10) || 3;
        i++;
        continue;
      }
      if (arg === '--retention') {
        i++;
        if (i < argv.length) retention = parseInt(argv[i], 10) || 12;
        i++;
        continue;
      }
      if (arg.startsWith('--retention=')) {
        retention = parseInt(arg.slice('--retention='.length), 10) || 12;
        i++;
        continue;
      }
      if (arg === '--key') {
        i++;
        if (i < argv.length) key = argv[i];
        i++;
        continue;
      }
      if (arg.startsWith('--key=')) {
        key = arg.slice('--key='.length);
        i++;
        continue;
      }
      if (arg === '--schema') {
        i++;
        if (i < argv.length) schema = argv[i];
        i++;
        continue;
      }
      if (arg.startsWith('--schema=')) {
        schema = arg.slice('--schema='.length);
        i++;
        continue;
      }
      if (arg === '--procedure') {
        i++;
        if (i < argv.length) procedureName = argv[i];
        i++;
        continue;
      }
      if (arg.startsWith('--procedure=')) {
        procedureName = arg.slice('--procedure='.length);
        i++;
        continue;
      }
      if (arg === '--lock-timeout') {
        i++;
        if (i < argv.length) lockTimeout = argv[i];
        i++;
        continue;
      }
      if (arg.startsWith('--lock-timeout=')) {
        lockTimeout = arg.slice('--lock-timeout='.length);
        i++;
        continue;
      }
      i++;
    }

    if (!parent) {
      console.error('ddlforge partition maintenance: --parent <tbl> flag is required.');
      return 1;
    }

    const { generatePartitionMaintenance } = await import('./partition/maintenance.js');
    const result = generatePartitionMaintenance({
      parent,
      interval,
      premake,
      retention,
      key,
      schema,
      procedureName: procedureName || undefined,
      lockTimeout,
    });
    console.log(result.fullSql);
    return 0;
  }

  console.error(`ddlforge partition: Unknown subcommand "${sub}". Supported subcommands: convert, attach, detach, maintenance.`);
  return 1;
}

/**
 * Pre-flight Blast Radius, Disk Capacity, and WAL Forecasting CLI handler.
 */
export async function runPreflight(argv: string[]): Promise<number> {
  let file = '';
  let dbUrl = process.env['DATABASE_URL'] ?? '';
  let targetTable = '';
  let operation: 'create_index' | 'table_rewrite' | 'auto' = 'auto';
  let availableBytes: number | undefined;
  let tableBytes: number | undefined;
  let toastBytes: number | undefined;
  let indexesBytes: number | undefined;
  let tuples: number | undefined;
  let maxLagMb = 100;
  let maxLagSec = 10;
  let schema = 'public';
  let format: 'terminal' | 'json' = 'terminal';
  let forceNoBackup = false;
  let rpoHours = 24;
  let backupProvider = 'catalog';
  let skipDrGuard = false;

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') {
      console.log(`
ddlforge preflight <file.sql> [options]

Pre-flight blast radius, disk capacity, and WAL forecasting engine.

ARGUMENTS:
  <file.sql>               Path to migration SQL file to evaluate (optional)

FLAGS:
  --db <url>               PostgreSQL connection URL (or DATABASE_URL env var)
  --target-table <tbl>     Target table name for disk footprint estimation
  --operation <type>       Operation type: create_index | table_rewrite | auto (default: auto)
  --available-bytes <n>    Available disk space in bytes (overrides live OS query)
  --table-bytes <n>        Table size in bytes (for static/simulation runs)
  --toast-bytes <n>        TOAST size in bytes (for static/simulation runs)
  --indexes-bytes <n>      Indexes size in bytes (for static/simulation runs)
  --tuples <n>             Live + dead tuple count (for static/simulation runs)
  --max-lag-mb <n>         Maximum acceptable replica lag in MB (default: 100)
  --max-lag-sec <n>        Maximum acceptable replica lag in seconds (default: 10)
  --force-no-backup        Bypass disaster recovery and backup RPO safety guard
  --rpo-hours <n>          Maximum acceptable backup age in hours (default: 24)
  --backup-provider <type> Backup provider: catalog | pgbackrest | mock (default: catalog)
  --skip-dr-guard          Skip continuous archiving and replication slot checks
  --schema <name>          Database schema (default: public)
  --format <type>          Output format: terminal | json (default: terminal)
  --help, -h               Print this help message and exit
`);
      return 0;
    }

    if (arg === '--db') {
      i++;
      if (i < argv.length) dbUrl = argv[i];
      i++;
      continue;
    }
    if (arg.startsWith('--db=')) {
      dbUrl = arg.slice('--db='.length);
      i++;
      continue;
    }

    if (arg === '--target-table') {
      i++;
      if (i < argv.length) targetTable = argv[i];
      i++;
      continue;
    }
    if (arg.startsWith('--target-table=')) {
      targetTable = arg.slice('--target-table='.length);
      i++;
      continue;
    }

    if (arg === '--operation') {
      i++;
      if (i < argv.length) {
        const op = argv[i].toLowerCase();
        if (op === 'create_index' || op === 'table_rewrite' || op === 'auto') operation = op;
      }
      i++;
      continue;
    }
    if (arg.startsWith('--operation=')) {
      const op = arg.slice('--operation='.length).toLowerCase();
      if (op === 'create_index' || op === 'table_rewrite' || op === 'auto') operation = op;
      i++;
      continue;
    }

    if (arg === '--available-bytes') {
      i++;
      if (i < argv.length) availableBytes = parseInt(argv[i], 10) || undefined;
      i++;
      continue;
    }
    if (arg.startsWith('--available-bytes=')) {
      availableBytes = parseInt(arg.slice('--available-bytes='.length), 10) || undefined;
      i++;
      continue;
    }

    if (arg === '--table-bytes') {
      i++;
      if (i < argv.length) tableBytes = parseInt(argv[i], 10) || undefined;
      i++;
      continue;
    }
    if (arg.startsWith('--table-bytes=')) {
      tableBytes = parseInt(arg.slice('--table-bytes='.length), 10) || undefined;
      i++;
      continue;
    }

    if (arg === '--toast-bytes') {
      i++;
      if (i < argv.length) toastBytes = parseInt(argv[i], 10) || undefined;
      i++;
      continue;
    }
    if (arg.startsWith('--toast-bytes=')) {
      toastBytes = parseInt(arg.slice('--toast-bytes='.length), 10) || undefined;
      i++;
      continue;
    }

    if (arg === '--indexes-bytes') {
      i++;
      if (i < argv.length) indexesBytes = parseInt(argv[i], 10) || undefined;
      i++;
      continue;
    }
    if (arg.startsWith('--indexes-bytes=')) {
      indexesBytes = parseInt(arg.slice('--indexes-bytes='.length), 10) || undefined;
      i++;
      continue;
    }

    if (arg === '--tuples') {
      i++;
      if (i < argv.length) tuples = parseInt(argv[i], 10) || undefined;
      i++;
      continue;
    }
    if (arg.startsWith('--tuples=')) {
      tuples = parseInt(arg.slice('--tuples='.length), 10) || undefined;
      i++;
      continue;
    }

    if (arg === '--max-lag-mb') {
      i++;
      if (i < argv.length) maxLagMb = parseInt(argv[i], 10) || 100;
      i++;
      continue;
    }
    if (arg.startsWith('--max-lag-mb=')) {
      maxLagMb = parseInt(arg.slice('--max-lag-mb='.length), 10) || 100;
      i++;
      continue;
    }

    if (arg === '--max-lag-sec') {
      i++;
      if (i < argv.length) maxLagSec = parseInt(argv[i], 10) || 10;
      i++;
      continue;
    }
    if (arg.startsWith('--max-lag-sec=')) {
      maxLagSec = parseInt(arg.slice('--max-lag-sec='.length), 10) || 10;
      i++;
      continue;
    }

    if (arg === '--schema') {
      i++;
      if (i < argv.length) schema = argv[i];
      i++;
      continue;
    }
    if (arg.startsWith('--schema=')) {
      schema = arg.slice('--schema='.length);
      i++;
      continue;
    }

    if (arg === '--format') {
      i++;
      if (i < argv.length && (argv[i] === 'json' || argv[i] === 'terminal')) {
        format = argv[i] as any;
      }
      i++;
      continue;
    }
    if (arg.startsWith('--format=')) {
      const f = arg.slice('--format='.length);
      if (f === 'json' || f === 'terminal') format = f as any;
      i++;
      continue;
    }

    if (arg === '--force-no-backup') {
      forceNoBackup = true;
      i++;
      continue;
    }

    if (arg === '--rpo-hours') {
      i++;
      if (i < argv.length) rpoHours = parseInt(argv[i], 10) || 24;
      i++;
      continue;
    }
    if (arg.startsWith('--rpo-hours=')) {
      rpoHours = parseInt(arg.slice('--rpo-hours='.length), 10) || 24;
      i++;
      continue;
    }

    if (arg === '--backup-provider') {
      i++;
      if (i < argv.length) backupProvider = argv[i];
      i++;
      continue;
    }
    if (arg.startsWith('--backup-provider=')) {
      backupProvider = arg.slice('--backup-provider='.length);
      i++;
      continue;
    }

    if (arg === '--skip-dr-guard') {
      skipDrGuard = true;
      i++;
      continue;
    }

    if (!arg.startsWith('-') && !file) {
      file = arg;
      i++;
      continue;
    }

    i++;
  }

  // Parse migration file if supplied
  if (file) {
    const resolvedPath = path.resolve(process.cwd(), file);
    if (!fs.existsSync(resolvedPath)) {
      console.error(`ddlforge preflight: Migration file not found: ${file}`);
      return 1;
    }
    const sqlContent = fs.readFileSync(resolvedPath, 'utf-8');

    // Auto-detect target table and operation if not explicitly provided
    if (!targetTable) {
      const indexMatch = sqlContent.match(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(?:[^\s(]+\s+)?ON\s+([^\s(;]+)/i);
      if (indexMatch) {
        targetTable = indexMatch[1].replace(/["`]/g, '').trim();
      } else {
        const alterMatch = sqlContent.match(/ALTER\s+TABLE\s+(?:ONLY\s+)?(?:IF\s+EXISTS\s+)?([^\s(;]+)/i);
        if (alterMatch) {
          targetTable = alterMatch[1].replace(/["`]/g, '').trim();
        }
      }
    }

    if (operation === 'auto') {
      if (/ALTER\s+TABLE.*(?:ALTER\s+COLUMN.*(?:TYPE|SET\s+DATA\s+TYPE)|CLUSTER|VACUUM\s+FULL)/is.test(sqlContent)) {
        operation = 'table_rewrite';
      } else {
        operation = 'create_index';
      }
    }
  }

  const {
    estimateIndexSpace,
    estimateTableRewriteSpace,
    detectSharedMount,
    checkDiskHeadroom,
    formatBytes,
    evaluateReplicationThrottle,
    auditSettings,
  } = await import('./preflight/index.js');

  const resolvedOperation = operation === 'auto' ? 'create_index' : operation;

  // Branch 1: Live database introspection (--db specified)
  if (dbUrl) {
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: dbUrl });

    try {
      const { auditDiskGuard, queryReplicationStatus, auditClusterConfig } = await import('./preflight/index.js');

      let diskReport: any = null;
      if (targetTable) {
        try {
          diskReport = await auditDiskGuard(pool, targetTable, {
            schema,
            operation: resolvedOperation,
            availableBytes,
          });
        } catch (err: any) {
          console.warn(`[ddlforge preflight] Disk guard query notice: ${err.message}`);
        }
      }

      const replicas = await queryReplicationStatus(pool);
      const throttleDecision = evaluateReplicationThrottle(replicas, {
        maxLagBytes: BigInt(maxLagMb) * 1024n * 1024n,
        maxLagSeconds: maxLagSec,
      });

      const configReport = await auditClusterConfig(pool);

      const { auditDisasterReadiness, auditBackupRpo, detectHighRiskOperations } = await import('./recovery/index.js');
      let disasterReport: any = null;
      try {
        disasterReport = await auditDisasterReadiness(pool);
      } catch (err: any) {
        console.warn(`[ddlforge preflight] Disaster readiness query notice: ${err.message}`);
      }

      let backupReport: any = null;
      try {
        backupReport = await auditBackupRpo(backupProvider as any, pool, { rpoHours });
      } catch (err: any) {
        console.warn(`[ddlforge preflight] Backup RPO query notice: ${err.message}`);
      }

      let highRiskAudit: { isHighRisk: boolean; reasons: string[] } = { isHighRisk: false, reasons: [] };
      if (file) {
        const resolved = path.resolve(process.cwd(), file);
        if (fs.existsSync(resolved)) {
          const sqlContent = fs.readFileSync(resolved, 'utf-8');
          highRiskAudit = detectHighRiskOperations(sqlContent);
        }
      }

      const isArchiverFailing = disasterReport?.archiver?.status === 'FAILING_NOW';
      const isRpoViolated = backupReport && !backupReport.isCompliant;

      if (highRiskAudit.isHighRisk && !skipDrGuard && (isArchiverFailing || isRpoViolated) && !forceNoBackup) {
        console.error(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✖ HIGH-RISK MIGRATION PREFLIGHT BLOCKED: DISASTER RECOVERY GUARD
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Migration contains high-risk operations:
${highRiskAudit.reasons.map((r: string) => `  - ${r}`).join('\n')}

SAFETY VIOLATIONS:`);
        if (isArchiverFailing) {
          console.error(`  - FAILING WAL ARCHIVE: pg_stat_archiver shows active archive failures. Point-in-time recovery is broken.`);
        }
        if (isRpoViolated) {
          console.error(`  - RPO THRESHOLD EXCEEDED: ${backupReport?.violationReason ?? `Backup exceeds ${rpoHours}h limit.`}`);
        }

        console.error(`
DIAGNOSTIC REMEDIATION STEPS:
  1. Inspect PostgreSQL WAL archiving: SELECT * FROM pg_stat_archiver;
  2. Verify or trigger a fresh backup before executing destructive migrations.
  3. Run 'ddlforge doctor --db <url>' to check cluster recovery readiness.
  4. To bypass this guard for testing or emergency maintenance, pass --force-no-backup.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
        return 1;
      }

      const hasFailures =
        (diskReport && !diskReport.passed) ||
        throttleDecision.shouldThrottle ||
        configReport.hasCriticalRisks;

      if (format === 'json') {
        const jsonOut = JSON.stringify(
          {
            targetTable: targetTable || null,
            operation: resolvedOperation,
            diskReport,
            replication: {
              replicaCount: throttleDecision.replicaCount,
              shouldThrottle: throttleDecision.shouldThrottle,
              recommendedThrottleMs: throttleDecision.recommendedThrottleMs,
              maxObservedLagBytes: throttleDecision.maxObservedLagBytes.toString(),
              maxObservedLagSeconds: throttleDecision.maxObservedLagSeconds,
              laggingReplicas: throttleDecision.laggingReplicas.map(r => ({
                ...r,
                lagBytes: r.lagBytes.toString(),
              })),
            },
            configReport,
            disasterReadiness: disasterReport,
            backupAudit: backupReport,
            passed: !hasFailures,
          },
          null,
          2
        );
        console.log(jsonOut);
        return hasFailures ? 1 : 0;
      }

      // Terminal Output
      console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ddlforge v${VERSION} — Pre-flight Blast Radius & Disk Guard
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

      if (targetTable && diskReport) {
        console.log(`
[1] STORAGE & DISK CAPACITY GUARD (${schema}.${targetTable})
  Operation:                 ${resolvedOperation.toUpperCase()}
  Mount Topology:            ${diskReport.sharedMount.isSharedMount ? 'SHARED (Warning: data_directory & pg_wal share filesystem)' : 'ISOLATED'}
  Disk Required:             ${formatBytes(diskReport.headroom.requiredBytes)} (with ${diskReport.headroom.safetyMultiplier}x headroom)
  Available Disk Space:      ${formatBytes(diskReport.headroom.availableBytes)}
  Projected Free Headroom:   ${formatBytes(diskReport.headroom.projectedRemainingBytes)} (${diskReport.headroom.projectedRemainingPercent.toFixed(1)}% remaining)
  Status:                    ${diskReport.headroom.status === 'SAFE' ? '✔ SAFE' : diskReport.headroom.status}`);
        if (diskReport.headroom.warning) {
          console.log(`  Warning:                   ${diskReport.headroom.warning}`);
        }
      }

      console.log(`
[2] REPLICATION STANDBY LAG & WAL THROTTLE
  Connected Standbys:        ${throttleDecision.replicaCount}
  Max Observed Lag:          ${(Number(throttleDecision.maxObservedLagBytes) / (1024 * 1024)).toFixed(1)} MB / ${throttleDecision.maxObservedLagSeconds.toFixed(1)}s
  Throttle Verdict:          ${throttleDecision.shouldThrottle ? `⚠ THROTTLE RECOMMENDED (Pause: ${throttleDecision.recommendedThrottleMs}ms)` : '✔ OPTIMAL (Within bounds)'}`);
      if (throttleDecision.laggingReplicas.length > 0) {
        for (const lag of throttleDecision.laggingReplicas) {
          console.log(`  - Standby ${lag.applicationName}: ${lag.detail}`);
        }
      }

      console.log(`
[3] STATIC CONFIGURATION & CHECKPOINT AUDIT
  Config Issues Found:       ${configReport.risks.length} (${configReport.risks.filter(r => r.severity === 'CRITICAL').length} critical, ${configReport.risks.filter(r => r.severity === 'HIGH').length} high)
  Checkpoint Pressure:       ${configReport.checkpointHealth?.pressureLevel || 'LOW'} (${configReport.checkpointHealth?.forcedPercentage.toFixed(1) || 0}% forced)`);
      if (configReport.checkpointHealth?.warning) {
        console.log(`  Checkpoint Warning:        ${configReport.checkpointHealth.warning}`);
      }
      for (const risk of configReport.risks) {
        console.log(`  - [${risk.severity}] ${risk.setting} = "${risk.currentValue}": ${risk.message}`);
      }

      if (disasterReport) {
        console.log(`
[4] CONTINUOUS WAL ARCHIVING & DISASTER RECOVERY
  Archiver Status:           ${disasterReport.archiver.status} (${disasterReport.archiver.archivedCount} archived, ${disasterReport.archiver.failedCount} failed)
  Replication Slots:         ${disasterReport.replicationSlots.hasDangerousSlots ? 'HAZARDOUS' : 'HEALTHY'}
  Standby Lag LSN:           ${disasterReport.standbys.hasLaggingStandby ? 'LAGGING' : 'SYNCHRONIZED'}`);
        if (!disasterReport.isReady) {
          for (const b of disasterReport.blockers) {
            console.log(`  - BLOCKER: ${b}`);
          }
        }
      }

      if (backupReport) {
        console.log(`
[5] BACKUP RECENCY & RPO COMPLIANCE
  Provider:                  ${backupReport.provider}
  RPO Threshold:             ${backupReport.rpoHours} hours
  Latest Backup:             ${backupReport.latestBackup ? backupReport.latestBackup.backupId : 'None'}
  Backup Age:                ${backupReport.actualAgeHours !== null ? `${backupReport.actualAgeHours.toFixed(1)} hours` : 'N/A'}
  RPO Status:                ${backupReport.isCompliant ? '✔ COMPLIANT' : '✖ NON-COMPLIANT'}`);
        if (!backupReport.isCompliant) {
          console.log(`  - Violation: ${backupReport.violationReason}`);
        }
      }

      console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  PRE-FLIGHT VERDICT: ${hasFailures ? '✖ FAILED (Pre-flight safety constraints violated)' : '✔ PASSED (Cluster is ready for migration execution)'}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);

      return hasFailures ? 1 : 0;
    } catch (err: any) {
      console.error(`ddlforge preflight: Database inspection error: ${err.message}`);
      return 1;
    } finally {
      await pool.end().catch(() => {});
    }
  }

  // Branch 2: Static / Offline Simulation Mode
  const effectiveTable = targetTable || 'target_table';
  const effectiveTuples = tuples ?? 1000000;
  const effectiveTableBytes = tableBytes ?? 1000000000; // 1 GB
  const effectiveToastBytes = toastBytes ?? 0;
  const effectiveIndexesBytes = indexesBytes ?? 200000000; // 200 MB
  const effectiveAvailableBytes = availableBytes ?? 50 * 1024 * 1024 * 1024; // 50 GB default

  let requiredBytes = 0;
  let indexEstimate: any = null;
  let rewriteEstimate: any = null;

  if (resolvedOperation === 'create_index') {
    indexEstimate = estimateIndexSpace({
      reltuples: effectiveTuples,
      tableBytes: effectiveTableBytes,
      safetyMultiplier: 1.75,
    });
    requiredBytes = indexEstimate.totalRequiredBytes;
  } else {
    rewriteEstimate = estimateTableRewriteSpace({
      heapBytes: effectiveTableBytes,
      toastBytes: effectiveToastBytes,
      indexesBytes: effectiveIndexesBytes,
      safetyMultiplier: 2.0,
    });
    requiredBytes = rewriteEstimate.totalRequiredBytes;
  }

  const headroom = checkDiskHeadroom(requiredBytes, effectiveAvailableBytes, 1.25);
  const sharedMount = detectSharedMount(process.cwd());

  if (format === 'json') {
    console.log(
      JSON.stringify(
        {
          mode: 'simulation',
          table: effectiveTable,
          operation: resolvedOperation,
          indexEstimate,
          rewriteEstimate,
          headroom,
          sharedMount,
          passed: headroom.hasSufficientSpace,
        },
        null,
        2
      )
    );
    return headroom.hasSufficientSpace ? 0 : 1;
  }

  console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ddlforge v${VERSION} — Pre-flight Blast Radius & Disk Forecast (Offline Simulation)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Target Table:              ${effectiveTable}
  Planned Operation:         ${resolvedOperation.toUpperCase()}
  Input Tuples:              ${effectiveTuples.toLocaleString()}
  Required Disk Space:       ${formatBytes(requiredBytes)} (safety multiplier factored)
  Available Disk Space:      ${formatBytes(effectiveAvailableBytes)}
  Projected Post-DDL Free:   ${formatBytes(headroom.projectedRemainingBytes)} (${headroom.projectedRemainingPercent.toFixed(1)}% remaining)
  Mount Topology:            ${sharedMount.isSharedMount ? 'SHARED (Warning)' : 'ISOLATED'}
  Status:                    ${headroom.hasSufficientSpace ? '✔ PASSED' : '✖ INSUFFICIENT DISK'}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);

  return headroom.hasSufficientSpace ? 0 : 1;
}

/**
 * Executes the `ddlforge doctor` subcommand.
 */
export async function runDoctor(argv: string[]): Promise<number> {
  let dbUrl = process.env['DATABASE_URL'] ?? '';
  let format: 'terminal' | 'json' = 'terminal';
  let staleMinutes = 15;
  let maxLagMb = 100;

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') {
      console.log(`
ddlforge doctor [options]

Continuous WAL archival health, replication slot bloat, and disaster recovery readiness doctor.

FLAGS:
  --db <url>            PostgreSQL connection URL (defaults to DATABASE_URL env var)
  --format <type>       Output format: terminal | json (default: terminal)
  --stale-minutes <n>   Archive staleness threshold in minutes (default: 15)
  --max-lag-mb <n>      Standby replay lag threshold in MB (default: 100)
  --help, -h            Print this help message and exit
`);
      return 0;
    }

    if (arg === '--db') {
      i++;
      if (i < argv.length) dbUrl = argv[i];
      i++;
      continue;
    }
    if (arg.startsWith('--db=')) {
      dbUrl = arg.slice('--db='.length);
      i++;
      continue;
    }

    if (arg === '--format') {
      i++;
      if (i < argv.length && (argv[i] === 'json' || argv[i] === 'terminal')) {
        format = argv[i] as any;
      }
      i++;
      continue;
    }
    if (arg.startsWith('--format=')) {
      const f = arg.slice('--format='.length);
      if (f === 'json' || f === 'terminal') format = f as any;
      i++;
      continue;
    }

    if (arg === '--stale-minutes') {
      i++;
      if (i < argv.length) staleMinutes = parseInt(argv[i], 10) || 15;
      i++;
      continue;
    }
    if (arg.startsWith('--stale-minutes=')) {
      staleMinutes = parseInt(arg.slice('--stale-minutes='.length), 10) || 15;
      i++;
      continue;
    }

    if (arg === '--max-lag-mb') {
      i++;
      if (i < argv.length) maxLagMb = parseInt(argv[i], 10) || 100;
      i++;
      continue;
    }
    if (arg.startsWith('--max-lag-mb=')) {
      maxLagMb = parseInt(arg.slice('--max-lag-mb='.length), 10) || 100;
      i++;
      continue;
    }

    i++;
  }

  if (!dbUrl) {
    console.error('ddlforge doctor: Missing required database connection URL (--db or DATABASE_URL).');
    return 1;
  }

  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: dbUrl });

  try {
    const { auditDisasterReadiness, formatDoctorReportTerminal, recordSafetyLog } = await import('./recovery/index.js');
    const report = await auditDisasterReadiness(pool, {
      staleArchiveIntervalMs: staleMinutes * 60 * 1000,
      maxStandbyLagBytes: BigInt(maxLagMb) * 1024n * 1024n,
    });

    // Record in migration safety log
    await recordSafetyLog(pool, {
      eventType: 'doctor_check',
      targetIdentifier: dbUrl.replace(/:[^:@]+@/, ':***@'),
      status: report.isReady ? (report.warnings.length > 0 ? 'WARNING' : 'PASSED') : 'FAILED',
      details: {
        archiverStatus: report.archiver.status,
        archivedCount: report.archiver.archivedCount.toString(),
        failedCount: report.archiver.failedCount.toString(),
        isReady: report.isReady,
        blockers: report.blockers,
        warnings: report.warnings,
      },
    });

    if (format === 'json') {
      console.log(
        JSON.stringify(
          {
            ...report,
            archiver: {
              ...report.archiver,
              archivedCount: report.archiver.archivedCount.toString(),
              failedCount: report.archiver.failedCount.toString(),
            },
            replicationSlots: {
              ...report.replicationSlots,
              totalRetainedBytes: report.replicationSlots.totalRetainedBytes.toString(),
              slots: report.replicationSlots.slots.map(s => ({
                ...s,
                retainedBytes: s.retainedBytes.toString(),
              })),
              dangerousSlots: report.replicationSlots.dangerousSlots.map(s => ({
                ...s,
                retainedBytes: s.retainedBytes.toString(),
              })),
              inactiveSlots: report.replicationSlots.inactiveSlots.map(s => ({
                ...s,
                retainedBytes: s.retainedBytes.toString(),
              })),
            },
            standbys: {
              ...report.standbys,
              maxReplayLagBytes: report.standbys.maxReplayLagBytes.toString(),
              standbys: report.standbys.standbys.map(s => ({
                ...s,
                replayLagBytes: s.replayLagBytes.toString(),
              })),
            },
          },
          null,
          2
        )
      );
    } else {
      console.log(formatDoctorReportTerminal(report));
    }

    return report.isReady ? 0 : 1;
  } catch (err: any) {
    console.error(`ddlforge doctor error: ${err.message}`);
    return 1;
  } finally {
    await pool.end().catch(() => {});
  }
}

/**
 * Executes the `ddlforge verify-backup` subcommand.
 */
export async function runVerifyBackup(argv: string[]): Promise<number> {
  let targetUrl = process.env['DATABASE_URL'] ?? '';
  let rpoHours = 24;
  let skipAmcheck = false;
  let format: 'terminal' | 'json' = 'terminal';

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') {
      console.log(`
ddlforge verify-backup [options]

Verify restored PostgreSQL instance health, recovery completion, and B-Tree index integrity.

FLAGS:
  --target-url <url>    Target database URL to verify (defaults to --db or DATABASE_URL)
  --db <url>            Alias for --target-url
  --rpo-hours <n>       Maximum acceptable RPO threshold in hours (default: 24)
  --skip-amcheck        Skip B-Tree index corruption checks via amcheck
  --format <type>       Output format: terminal | json (default: terminal)
  --help, -h            Print this help message and exit
`);
      return 0;
    }

    if (arg === '--target-url' || arg === '--db') {
      i++;
      if (i < argv.length) targetUrl = argv[i];
      i++;
      continue;
    }
    if (arg.startsWith('--target-url=')) {
      targetUrl = arg.slice('--target-url='.length);
      i++;
      continue;
    }
    if (arg.startsWith('--db=')) {
      targetUrl = arg.slice('--db='.length);
      i++;
      continue;
    }

    if (arg === '--rpo-hours') {
      i++;
      if (i < argv.length) rpoHours = parseInt(argv[i], 10) || 24;
      i++;
      continue;
    }
    if (arg.startsWith('--rpo-hours=')) {
      rpoHours = parseInt(arg.slice('--rpo-hours='.length), 10) || 24;
      i++;
      continue;
    }

    if (arg === '--skip-amcheck') {
      skipAmcheck = true;
      i++;
      continue;
    }

    if (arg === '--format') {
      i++;
      if (i < argv.length && (argv[i] === 'json' || argv[i] === 'terminal')) {
        format = argv[i] as any;
      }
      i++;
      continue;
    }
    if (arg.startsWith('--format=')) {
      const f = arg.slice('--format='.length);
      if (f === 'json' || f === 'terminal') format = f as any;
      i++;
      continue;
    }

    i++;
  }

  if (!targetUrl) {
    console.error('ddlforge verify-backup: Missing required target database connection URL (--target-url, --db or DATABASE_URL).');
    return 1;
  }

  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: targetUrl });

  try {
    const { verifyRestoredInstance, formatRestoreReportTerminal } = await import('./recovery/index.js');
    const report = await verifyRestoredInstance(pool, {
      targetUrl,
      skipAmcheck,
      rpoHours,
    });

    if (format === 'json') {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatRestoreReportTerminal(report));
    }

    return report.passed ? 0 : 1;
  } catch (err: any) {
    console.error(`ddlforge verify-backup error: ${err.message}`);
    return 1;
  } finally {
    await pool.end().catch(() => {});
  }
}

/**
 * Executes the `ddlforge compact` subcommand.
 */
export async function runCompact(argv: string[]): Promise<number> {
  const sub = argv[0];

  if (!sub || sub === '--help' || sub === '-h') {
    console.log(`
ddlforge compact <subcommand> [options]

Zero-downtime table compaction, in-place defragmentation, and statistical bloat estimator.

SUBCOMMANDS:
  estimate            Mathematically estimate table and B-Tree index bloat without seqscans
  table               Generate 5-phase zero-downtime online table repack SQL script
  index               Generate autocommit-safe lock-free concurrent index rebuild statement

EXAMPLES:
  $ ddlforge compact estimate --db postgres://localhost/mydb
  $ ddlforge compact table --table orders --pk id --batch-size 5000
  $ ddlforge compact index --table orders --index idx_orders_customer
`);
    return 0;
  }

  // Subcommand 1: ddlforge compact estimate
  if (sub === 'estimate') {
    const subArgs = argv.slice(1);
    let dbUrl = process.env['DATABASE_URL'] ?? '';
    let table = '';
    let schema = 'public';
    let threshold = 25;
    let format: 'terminal' | 'json' = 'terminal';

    let i = 0;
    while (i < subArgs.length) {
      const arg = subArgs[i];
      if (arg === '--help' || arg === '-h') {
        console.log(`
ddlforge compact estimate [options]

Mathematically estimate table and B-Tree index bloat without sequential scans.

FLAGS:
  --db <url>          PostgreSQL connection URL (or DATABASE_URL env var)
  --table <table>     Filter by specific table name (optional)
  --schema <name>     Target PostgreSQL schema (default: public)
  --threshold <pct>   Bloat percentage threshold for repack recommendation (default: 25)
  --format <type>     Output format: terminal | json (default: terminal)
  --help, -h          Print this help message and exit
`);
        return 0;
      }
      if (arg === '--db') {
        i++;
        if (i < subArgs.length) dbUrl = subArgs[i];
        i++;
        continue;
      }
      if (arg.startsWith('--db=')) {
        dbUrl = arg.slice('--db='.length);
        i++;
        continue;
      }
      if (arg === '--table') {
        i++;
        if (i < subArgs.length) table = subArgs[i];
        i++;
        continue;
      }
      if (arg.startsWith('--table=')) {
        table = arg.slice('--table='.length);
        i++;
        continue;
      }
      if (arg === '--schema') {
        i++;
        if (i < subArgs.length) schema = subArgs[i];
        i++;
        continue;
      }
      if (arg.startsWith('--schema=')) {
        schema = arg.slice('--schema='.length);
        i++;
        continue;
      }
      if (arg === '--threshold') {
        i++;
        if (i < subArgs.length) threshold = parseInt(subArgs[i], 10) || 25;
        i++;
        continue;
      }
      if (arg.startsWith('--threshold=')) {
        threshold = parseInt(arg.slice('--threshold='.length), 10) || 25;
        i++;
        continue;
      }
      if (arg === '--format') {
        i++;
        if (i < subArgs.length && (subArgs[i] === 'json' || subArgs[i] === 'terminal')) {
          format = subArgs[i] as any;
        }
        i++;
        continue;
      }
      if (arg.startsWith('--format=')) {
        const f = arg.slice('--format='.length);
        if (f === 'json' || f === 'terminal') format = f as any;
        i++;
        continue;
      }
      i++;
    }

    if (!dbUrl) {
      console.error('ddlforge compact estimate: Missing required database connection URL (--db or DATABASE_URL).');
      return 1;
    }

    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: dbUrl });

    try {
      const { queryLiveBloatEstimates, formatBloatReportTerminal } = await import('./compaction/index.js');
      const report = await queryLiveBloatEstimates(pool, {
        schema,
        table: table || undefined,
        thresholdPercent: threshold,
      });

      if (format === 'json') {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(formatBloatReportTerminal(report));
      }
      return 0;
    } catch (err: any) {
      console.error(`ddlforge compact estimate error: ${err.message}`);
      return 1;
    } finally {
      await pool.end().catch(() => {});
    }
  }

  // Subcommand 2: ddlforge compact table
  if (sub === 'table') {
    const subArgs = argv.slice(1);
    let table = '';
    let pk = 'id';
    let pkType = 'BIGINT';
    let schema = 'public';
    let batchSize = 5000;
    let throttleMs = 20;
    let shadowTable = '';
    let logTable = '';
    let archiveTable = '';
    let tablespace = '';
    let fillfactor: number | undefined;
    let lockTimeout = '250ms';
    let statementTimeout = '5s';
    let format: 'terminal' | 'json' = 'terminal';

    let i = 0;
    while (i < subArgs.length) {
      const arg = subArgs[i];
      if (arg === '--help' || arg === '-h') {
        console.log(`
ddlforge compact table --table <table> --pk <id> [options]

Generate 5-phase zero-downtime online table repack SQL script.

FLAGS:
  --table <table>         Monolithic table name to compact (required)
  --pk <id>               Primary key column for keyset backfill (default: id)
  --pk-type <type>        Primary key column data type (default: BIGINT)
  --batch-size <n>        Backfill and replay batch size per commit (default: 5000)
  --throttle-ms <n>       Jittered sleep throttle between batches in ms (default: 20)
  --lock-timeout <t>      Cutover transaction lock timeout (default: 250ms)
  --statement-timeout <t> Cutover statement timeout (default: 5s)
  --fillfactor <n>        Fillfactor for repacked shadow table (e.g. 85 or 90)
  --tablespace <name>     Target tablespace for shadow table
  --shadow-table <name>   Shadow table name (default: <table>_repack_shadow)
  --log-table <name>      Change log table name (default: <table>_repack_log)
  --archive-table <name>  Archive table name for legacy table (default: <table>_legacy)
  --schema <name>         Target PostgreSQL schema (default: public)
  --format <type>         Output format: terminal | json (default: terminal)
  --help, -h              Print this help message and exit
`);
        return 0;
      }
      if (arg === '--table') {
        i++;
        if (i < subArgs.length) table = subArgs[i];
        i++;
        continue;
      }
      if (arg.startsWith('--table=')) {
        table = arg.slice('--table='.length);
        i++;
        continue;
      }
      if (arg === '--pk') {
        i++;
        if (i < subArgs.length) pk = subArgs[i];
        i++;
        continue;
      }
      if (arg.startsWith('--pk=')) {
        pk = arg.slice('--pk='.length);
        i++;
        continue;
      }
      if (arg === '--pk-type') {
        i++;
        if (i < subArgs.length) pkType = subArgs[i];
        i++;
        continue;
      }
      if (arg.startsWith('--pk-type=')) {
        pkType = arg.slice('--pk-type='.length);
        i++;
        continue;
      }
      if (arg === '--schema') {
        i++;
        if (i < subArgs.length) schema = subArgs[i];
        i++;
        continue;
      }
      if (arg.startsWith('--schema=')) {
        schema = arg.slice('--schema='.length);
        i++;
        continue;
      }
      if (arg === '--batch-size') {
        i++;
        if (i < subArgs.length) batchSize = parseInt(subArgs[i], 10) || 5000;
        i++;
        continue;
      }
      if (arg.startsWith('--batch-size=')) {
        batchSize = parseInt(arg.slice('--batch-size='.length), 10) || 5000;
        i++;
        continue;
      }
      if (arg === '--throttle-ms') {
        i++;
        if (i < subArgs.length) throttleMs = parseInt(subArgs[i], 10) || 20;
        i++;
        continue;
      }
      if (arg.startsWith('--throttle-ms=')) {
        throttleMs = parseInt(arg.slice('--throttle-ms='.length), 10) || 20;
        i++;
        continue;
      }
      if (arg === '--lock-timeout') {
        i++;
        if (i < subArgs.length) lockTimeout = subArgs[i];
        i++;
        continue;
      }
      if (arg.startsWith('--lock-timeout=')) {
        lockTimeout = arg.slice('--lock-timeout='.length);
        i++;
        continue;
      }
      if (arg === '--statement-timeout') {
        i++;
        if (i < subArgs.length) statementTimeout = subArgs[i];
        i++;
        continue;
      }
      if (arg.startsWith('--statement-timeout=')) {
        statementTimeout = arg.slice('--statement-timeout='.length);
        i++;
        continue;
      }
      if (arg === '--fillfactor') {
        i++;
        if (i < subArgs.length) fillfactor = parseInt(subArgs[i], 10) || undefined;
        i++;
        continue;
      }
      if (arg.startsWith('--fillfactor=')) {
        fillfactor = parseInt(arg.slice('--fillfactor='.length), 10) || undefined;
        i++;
        continue;
      }
      if (arg === '--tablespace') {
        i++;
        if (i < subArgs.length) tablespace = subArgs[i];
        i++;
        continue;
      }
      if (arg.startsWith('--tablespace=')) {
        tablespace = arg.slice('--tablespace='.length);
        i++;
        continue;
      }
      if (arg === '--shadow-table') {
        i++;
        if (i < subArgs.length) shadowTable = subArgs[i];
        i++;
        continue;
      }
      if (arg.startsWith('--shadow-table=')) {
        shadowTable = arg.slice('--shadow-table='.length);
        i++;
        continue;
      }
      if (arg === '--log-table') {
        i++;
        if (i < subArgs.length) logTable = subArgs[i];
        i++;
        continue;
      }
      if (arg.startsWith('--log-table=')) {
        logTable = arg.slice('--log-table='.length);
        i++;
        continue;
      }
      if (arg === '--archive-table') {
        i++;
        if (i < subArgs.length) archiveTable = subArgs[i];
        i++;
        continue;
      }
      if (arg.startsWith('--archive-table=')) {
        archiveTable = arg.slice('--archive-table='.length);
        i++;
        continue;
      }
      if (arg === '--format') {
        i++;
        if (i < subArgs.length && (subArgs[i] === 'json' || subArgs[i] === 'terminal')) {
          format = subArgs[i] as any;
        }
        i++;
        continue;
      }
      if (arg.startsWith('--format=')) {
        const f = arg.slice('--format='.length);
        if (f === 'json' || f === 'terminal') format = f as any;
        i++;
        continue;
      }
      i++;
    }

    if (!table) {
      console.error('ddlforge compact table: --table <table> flag is required.');
      return 1;
    }

    const { generateTableRepack } = await import('./compaction/index.js');
    const { generateAdvisoryKey } = await import('./cluster/advisory.js');
    const advisoryKey = generateAdvisoryKey('repack', `${schema}:${table}`);

    const result = generateTableRepack({
      table,
      primaryKey: pk,
      primaryKeyType: pkType,
      schema,
      batchSize,
      throttleMs,
      shadowTable: shadowTable || undefined,
      logTable: logTable || undefined,
      archiveTable: archiveTable || undefined,
      tablespace: tablespace || undefined,
      fillfactor,
      lockTimeout,
      statementTimeout,
    });

    if (format === 'json') {
      console.log(
        JSON.stringify(
          {
            table,
            schema,
            primaryKey: pk,
            advisoryKey: advisoryKey.toString(),
            phases: {
              phase1: result.phase1Sql,
              phase2: result.phase2Sql,
              phase3: result.phase3Sql,
              phase4: result.phase4Sql,
              phase5: result.phase5Sql,
            },
            fullSql: result.fullSql,
          },
          null,
          2
        )
      );
    } else {
      console.log(`-- ============================================================================
-- ddlforge v${VERSION} — Zero-Downtime Table Compaction Script (Online Repack)
-- Target Relation: "${schema}"."${table}"
-- Primary Key:     "${pk}" (${pkType})
-- Advisory Lock:   ${advisoryKey.toString()} (ddlforge:repack:${schema}:${table})
-- ============================================================================

${result.fullSql}`);
    }
    return 0;
  }

  // Subcommand 3: ddlforge compact index
  if (sub === 'index') {
    const subArgs = argv.slice(1);
    let table = '';
    let index = '';
    let schema = 'public';

    let i = 0;
    while (i < subArgs.length) {
      const arg = subArgs[i];
      if (arg === '--help' || arg === '-h') {
        console.log(`
ddlforge compact index --table <table> [--index <name>] [options]

Generate autocommit-safe lock-free concurrent index rebuild statement.

FLAGS:
  --table <table>     Target table name (required)
  --index <name>      Target index name (optional, defaults to rebuilding all table indexes)
  --schema <name>     Target PostgreSQL schema (default: public)
  --help, -h          Print this help message and exit
`);
        return 0;
      }
      if (arg === '--table') {
        i++;
        if (i < subArgs.length) table = subArgs[i];
        i++;
        continue;
      }
      if (arg.startsWith('--table=')) {
        table = arg.slice('--table='.length);
        i++;
        continue;
      }
      if (arg === '--index') {
        i++;
        if (i < subArgs.length) index = subArgs[i];
        i++;
        continue;
      }
      if (arg.startsWith('--index=')) {
        index = arg.slice('--index='.length);
        i++;
        continue;
      }
      if (arg === '--schema') {
        i++;
        if (i < subArgs.length) schema = subArgs[i];
        i++;
        continue;
      }
      if (arg.startsWith('--schema=')) {
        schema = arg.slice('--schema='.length);
        i++;
        continue;
      }
      i++;
    }

    if (!table) {
      console.error('ddlforge compact index: --table <table> flag is required.');
      return 1;
    }

    const { generateReindexScript } = await import('./compaction/index.js');
    const result = generateReindexScript({
      table,
      index: index || undefined,
      schema,
    });

    console.log(`-- ${result.explanation}\n${result.sql}`);
    return 0;
  }

  console.error(`ddlforge compact: Unknown subcommand "${sub}". Supported subcommands: estimate, table, index.`);
  return 1;
}

/**
 * Executes the `ddlforge tenant` subcommand.
 */
export async function runTenant(argv: string[]): Promise<number> {
  const sub = argv[0];

  if (!sub || sub === '--help' || sub === '-h') {
    console.log(`
ddlforge tenant <subcommand> [options]

Multi-tenant schema distribution, distributed DDL state machine, and cross-tenant drift auditing.

SUBCOMMANDS:
  migrate             Distribute DDL migration across multi-tenant fleet (schema or database)
  audit               Audit cross-tenant schema drift and generate zero-downtime reconciliation SQL
  sweep               Self-healing sweeper for stale/orphaned distributed DDL runs

EXAMPLES:
  $ ddlforge tenant migrate --strategy schema --pattern "tenant_*" --file migration.sql --concurrency 8
  $ ddlforge tenant audit --strategy schema --pattern "tenant_*" --golden tenant_001
  $ ddlforge tenant sweep --max-age-minutes 30
`);
    return 0;
  }

  // Subcommand 1: ddlforge tenant migrate
  if (sub === 'migrate') {
    const subArgs = argv.slice(1);
    let strategy: 'schema' | 'database' = 'schema';
    let pattern = 'tenant_*';
    let file = '';
    let concurrency = 8;
    let rateLimit: number | undefined;
    let throttleMs = 0;
    let stopOnError = false;
    let dbUrl = process.env['DATABASE_URL'] ?? '';
    let configFile = '';
    let format: 'terminal' | 'json' = 'terminal';

    let i = 0;
    while (i < subArgs.length) {
      const arg = subArgs[i];
      if (arg === '--help' || arg === '-h') {
        console.log(`
ddlforge tenant migrate [options]

Distribute DDL migration across multi-tenant fleet with bounded worker pool and distributed state tracking.

FLAGS:
  --strategy <type>   Multi-tenant topology: schema | database (default: schema)
  --pattern <glob>    Schema name pattern for schema-per-tenant (default: tenant_*)
  --file <path>       Migration SQL file to execute across tenants (optional for discovery-only)
  --concurrency <n>   Concurrent worker pool limit (default: 8)
  --rate-limit <n>    Maximum tenant operations per second
  --throttle-ms <n>   Delay in ms between initiating tenant tasks (default: 0)
  --stop-on-error     Halt execution immediately on first tenant failure
  --db <url>          PostgreSQL connection URL (or DATABASE_URL)
  --config <path>     JSON config file for database-per-tenant strategy
  --format <type>     Output format: terminal | json (default: terminal)
  --help, -h          Print this help message and exit
`);
        return 0;
      }
      if (arg === '--strategy') {
        i++;
        if (i < subArgs.length && (subArgs[i] === 'schema' || subArgs[i] === 'database')) strategy = subArgs[i] as any;
        i++;
        continue;
      }
      if (arg.startsWith('--strategy=')) {
        const s = arg.slice('--strategy='.length);
        if (s === 'schema' || s === 'database') strategy = s as any;
        i++;
        continue;
      }
      if (arg === '--pattern') {
        i++;
        if (i < subArgs.length) pattern = subArgs[i];
        i++;
        continue;
      }
      if (arg.startsWith('--pattern=')) {
        pattern = arg.slice('--pattern='.length);
        i++;
        continue;
      }
      if (arg === '--file') {
        i++;
        if (i < subArgs.length) file = subArgs[i];
        i++;
        continue;
      }
      if (arg.startsWith('--file=')) {
        file = arg.slice('--file='.length);
        i++;
        continue;
      }
      if (arg === '--concurrency') {
        i++;
        if (i < subArgs.length) concurrency = parseInt(subArgs[i], 10) || 8;
        i++;
        continue;
      }
      if (arg.startsWith('--concurrency=')) {
        concurrency = parseInt(arg.slice('--concurrency='.length), 10) || 8;
        i++;
        continue;
      }
      if (arg === '--rate-limit') {
        i++;
        if (i < subArgs.length) rateLimit = parseInt(subArgs[i], 10) || undefined;
        i++;
        continue;
      }
      if (arg.startsWith('--rate-limit=')) {
        rateLimit = parseInt(arg.slice('--rate-limit='.length), 10) || undefined;
        i++;
        continue;
      }
      if (arg === '--throttle-ms') {
        i++;
        if (i < subArgs.length) throttleMs = parseInt(subArgs[i], 10) || 0;
        i++;
        continue;
      }
      if (arg.startsWith('--throttle-ms=')) {
        throttleMs = parseInt(arg.slice('--throttle-ms='.length), 10) || 0;
        i++;
        continue;
      }
      if (arg === '--stop-on-error') {
        stopOnError = true;
        i++;
        continue;
      }
      if (arg === '--db') {
        i++;
        if (i < subArgs.length) dbUrl = subArgs[i];
        i++;
        continue;
      }
      if (arg.startsWith('--db=')) {
        dbUrl = arg.slice('--db='.length);
        i++;
        continue;
      }
      if (arg === '--config') {
        i++;
        if (i < subArgs.length) configFile = subArgs[i];
        i++;
        continue;
      }
      if (arg.startsWith('--config=')) {
        configFile = arg.slice('--config='.length);
        i++;
        continue;
      }
      if (arg === '--format') {
        i++;
        if (i < subArgs.length && (subArgs[i] === 'json' || subArgs[i] === 'terminal')) format = subArgs[i] as any;
        i++;
        continue;
      }
      if (arg.startsWith('--format=')) {
        const f = arg.slice('--format='.length);
        if (f === 'json' || f === 'terminal') format = f as any;
        i++;
        continue;
      }
      i++;
    }

    if (strategy === 'schema' && !dbUrl) {
      console.error('ddlforge tenant migrate: Missing required database connection URL (--db or DATABASE_URL).');
      return 1;
    }

    if (strategy === 'database' && !configFile && !dbUrl) {
      console.error('ddlforge tenant migrate: For database-per-tenant, --config <file> or --db <url> must be provided.');
      return 1;
    }

    let sqlContent = '';
    if (file) {
      if (!fs.existsSync(file)) {
        console.error(`ddlforge tenant migrate: Migration file "${file}" not found.`);
        return 1;
      }
      sqlContent = fs.readFileSync(file, 'utf-8');
    }

    const { Pool } = await import('pg');
    const pool = dbUrl ? new Pool({ connectionString: dbUrl }) : null;

    try {
      const {
        discoverTenants,
        executeWorkerPool,
        formatExecutionSummaryTerminal,
        prepareDistributedRun,
        commitDistributedRun,
        abortDistributedRun,
      } = await import('./distributed/index.js');

      const targets = await discoverTenants(pool, {
        strategy,
        pattern,
        configFile: configFile || undefined,
      });

      if (targets.length === 0) {
        console.log(`[ddlforge tenant] No tenants discovered matching pattern "${pattern}".`);
        return 0;
      }

      if (!sqlContent) {
        // Discovery-only run
        if (format === 'json') {
          console.log(JSON.stringify({ strategy, pattern, total: targets.length, tenants: targets }, null, 2));
        } else {
          console.log(`[ddlforge tenant] Discovered ${targets.length} tenant(s) for strategy "${strategy}":`);
          for (const t of targets) {
            console.log(`  • ${t.name} (strategy: ${t.strategy}, schema: ${t.schema || 'N/A'})`);
          }
        }
        return 0;
      }

      // Execute migration with two-phase coordinator tracking
      const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const migrationVersion = path.basename(file);

      const summary = await executeWorkerPool(
        targets,
        async (target) => {
          const targetPool = target.connectionUrl ? new Pool({ connectionString: target.connectionUrl }) : pool!;
          const shouldCloseTargetPool = Boolean(target.connectionUrl);

          try {
            // 1. Prepare intent in state ledger
            if (pool) {
              await prepareDistributedRun(pool, {
                runId,
                migrationVersion,
                nodeId: target.id,
                ddlStatement: sqlContent,
              });
            }

            // 2. Execute DDL in tenant context
            const client = await targetPool.connect();
            try {
              if (target.schema) {
                await client.query(`SET LOCAL search_path = "${target.schema.replace(/"/g, '""')}", public;`);
              }
              await client.query(`SET LOCAL lock_timeout = '2s';`);
              await client.query(sqlContent);
            } finally {
              client.release();
            }

            // 3. Commit intent in state ledger
            if (pool) {
              await commitDistributedRun(pool, {
                runId,
                nodeId: target.id,
              });
            }
            return { committed: true };
          } catch (err: any) {
            if (pool) {
              await abortDistributedRun(pool, {
                runId,
                nodeId: target.id,
                error: err?.message ?? String(err),
              }).catch(() => {});
            }
            throw err;
          } finally {
            if (shouldCloseTargetPool) {
              await targetPool.end().catch(() => {});
            }
          }
        },
        {
          concurrency,
          rateLimitPerSec: rateLimit,
          throttleMs,
          stopOnError,
        }
      );

      if (format === 'json') {
        console.log(JSON.stringify(summary, null, 2));
      } else {
        console.log(formatExecutionSummaryTerminal(summary));
      }

      return summary.failed > 0 ? 1 : 0;
    } catch (err: any) {
      console.error(`ddlforge tenant migrate error: ${err.message}`);
      return 1;
    } finally {
      if (pool) await pool.end().catch(() => {});
    }
  }

  // Subcommand 2: ddlforge tenant audit
  if (sub === 'audit') {
    const subArgs = argv.slice(1);
    let strategy: 'schema' | 'database' = 'schema';
    let pattern = 'tenant_*';
    let goldenTenant = '';
    let dbUrl = process.env['DATABASE_URL'] ?? '';
    let configFile = '';
    let format: 'terminal' | 'json' = 'terminal';

    let i = 0;
    while (i < subArgs.length) {
      const arg = subArgs[i];
      if (arg === '--help' || arg === '-h') {
        console.log(`
ddlforge tenant audit [options]

Audit cross-tenant schema drift and generate zero-downtime reconciliation SQL.

FLAGS:
  --strategy <type>   Multi-tenant topology: schema | database (default: schema)
  --pattern <glob>    Schema name pattern for schema-per-tenant (default: tenant_*)
  --golden <name>     Reference golden tenant/schema (default: auto-detected by consensus)
  --db <url>          PostgreSQL connection URL (or DATABASE_URL)
  --config <path>     JSON config file for database-per-tenant strategy
  --format <type>     Output format: terminal | json (default: terminal)
  --help, -h          Print this help message and exit
`);
        return 0;
      }
      if (arg === '--strategy') {
        i++;
        if (i < subArgs.length && (subArgs[i] === 'schema' || subArgs[i] === 'database')) strategy = subArgs[i] as any;
        i++;
        continue;
      }
      if (arg.startsWith('--strategy=')) {
        const s = arg.slice('--strategy='.length);
        if (s === 'schema' || s === 'database') strategy = s as any;
        i++;
        continue;
      }
      if (arg === '--pattern') {
        i++;
        if (i < subArgs.length) pattern = subArgs[i];
        i++;
        continue;
      }
      if (arg.startsWith('--pattern=')) {
        pattern = arg.slice('--pattern='.length);
        i++;
        continue;
      }
      if (arg === '--golden') {
        i++;
        if (i < subArgs.length) goldenTenant = subArgs[i];
        i++;
        continue;
      }
      if (arg.startsWith('--golden=')) {
        goldenTenant = arg.slice('--golden='.length);
        i++;
        continue;
      }
      if (arg === '--db') {
        i++;
        if (i < subArgs.length) dbUrl = subArgs[i];
        i++;
        continue;
      }
      if (arg.startsWith('--db=')) {
        dbUrl = arg.slice('--db='.length);
        i++;
        continue;
      }
      if (arg === '--config') {
        i++;
        if (i < subArgs.length) configFile = subArgs[i];
        i++;
        continue;
      }
      if (arg.startsWith('--config=')) {
        configFile = arg.slice('--config='.length);
        i++;
        continue;
      }
      if (arg === '--format') {
        i++;
        if (i < subArgs.length && (subArgs[i] === 'json' || subArgs[i] === 'terminal')) format = subArgs[i] as any;
        i++;
        continue;
      }
      if (arg.startsWith('--format=')) {
        const f = arg.slice('--format='.length);
        if (f === 'json' || f === 'terminal') format = f as any;
        i++;
        continue;
      }
      i++;
    }

    if (!dbUrl && strategy === 'schema') {
      console.error('ddlforge tenant audit: Missing required database connection URL (--db or DATABASE_URL).');
      return 1;
    }

    const { Pool } = await import('pg');
    const pool = dbUrl ? new Pool({ connectionString: dbUrl }) : null;

    try {
      const {
        discoverTenants,
        introspectTenantSchemas,
        evaluateFleetDrift,
        formatDriftReportTerminal,
      } = await import('./distributed/index.js');

      const targets = await discoverTenants(pool, {
        strategy,
        pattern,
        configFile: configFile || undefined,
      });

      if (targets.length === 0) {
        console.log(`[ddlforge tenant audit] No tenants discovered matching pattern "${pattern}".`);
        return 0;
      }

      const tenantSchemas = await introspectTenantSchemas(pool!, targets);
      const report = evaluateFleetDrift(tenantSchemas, {
        goldenTenant: goldenTenant || undefined,
      });

      if (format === 'json') {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(formatDriftReportTerminal(report));
      }

      return report.driftedCount > 0 ? 1 : 0;
    } catch (err: any) {
      console.error(`ddlforge tenant audit error: ${err.message}`);
      return 1;
    } finally {
      if (pool) await pool.end().catch(() => {});
    }
  }

  // Subcommand 3: ddlforge tenant sweep
  if (sub === 'sweep') {
    const subArgs = argv.slice(1);
    let dbUrl = process.env['DATABASE_URL'] ?? '';
    let maxAgeMinutes = 30;
    let autoHeal = true;
    let dryRun = false;
    let format: 'terminal' | 'json' = 'terminal';

    let i = 0;
    while (i < subArgs.length) {
      const arg = subArgs[i];
      if (arg === '--help' || arg === '-h') {
        console.log(`
ddlforge tenant sweep [options]

Self-healing orphan sweeper for stale/abandoned distributed DDL runs.

FLAGS:
  --db <url>              PostgreSQL connection URL (or DATABASE_URL)
  --max-age-minutes <n>   Age threshold in minutes for stale PREPARED runs (default: 30)
  --auto-heal             Automatically heal stale runs if fleet consensus succeeded (default: true)
  --no-auto-heal          Disable automated healing
  --dry-run               Preview sweep decisions without updating ledger table
  --format <type>         Output format: terminal | json (default: terminal)
  --help, -h              Print this help message and exit
`);
        return 0;
      }
      if (arg === '--db') {
        i++;
        if (i < subArgs.length) dbUrl = subArgs[i];
        i++;
        continue;
      }
      if (arg.startsWith('--db=')) {
        dbUrl = arg.slice('--db='.length);
        i++;
        continue;
      }
      if (arg === '--max-age-minutes') {
        i++;
        if (i < subArgs.length) maxAgeMinutes = parseInt(subArgs[i], 10) || 30;
        i++;
        continue;
      }
      if (arg.startsWith('--max-age-minutes=')) {
        maxAgeMinutes = parseInt(arg.slice('--max-age-minutes='.length), 10) || 30;
        i++;
        continue;
      }
      if (arg === '--auto-heal') {
        autoHeal = true;
        i++;
        continue;
      }
      if (arg === '--no-auto-heal') {
        autoHeal = false;
        i++;
        continue;
      }
      if (arg === '--dry-run') {
        dryRun = true;
        i++;
        continue;
      }
      if (arg === '--format') {
        i++;
        if (i < subArgs.length && (subArgs[i] === 'json' || subArgs[i] === 'terminal')) format = subArgs[i] as any;
        i++;
        continue;
      }
      if (arg.startsWith('--format=')) {
        const f = arg.slice('--format='.length);
        if (f === 'json' || f === 'terminal') format = f as any;
        i++;
        continue;
      }
      i++;
    }

    if (!dbUrl) {
      console.error('ddlforge tenant sweep: Missing required database connection URL (--db or DATABASE_URL).');
      return 1;
    }

    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: dbUrl });

    try {
      const { sweepDistributedRuns, formatSweepReportTerminal } = await import('./distributed/index.js');
      const report = await sweepDistributedRuns(pool, {
        maxAgeMinutes,
        autoHeal,
        dryRun,
      });

      if (format === 'json') {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(formatSweepReportTerminal(report));
      }

      return 0;
    } catch (err: any) {
      console.error(`ddlforge tenant sweep error: ${err.message}`);
      return 1;
    } finally {
      await pool.end().catch(() => {});
    }
  }

  console.error(`ddlforge tenant: Unknown subcommand "${sub}". Supported subcommands: migrate, audit, sweep.`);
  return 1;
}

/**
 * Executes the `ddlforge advisor` subcommand.
 */
export async function runAdvisor(argv: string[]): Promise<number> {
  const sub = argv[0];

  if (!sub || sub === '--help' || sub === '-h') {
    console.log(`
ddlforge advisor <subcommand> [options]

Autonomous query telemetry, hypothetical index simulation (hypopg), and index lifecycle advisor.

SUBCOMMANDS:
  analyze             Mine table Read/Write ratios, HOT update efficiencies, and slow queries
  simulate            Simulate hypothetical index in-memory with hypopg to calculate cost reduction
  prune               Discover unused, prefix-subsumed redundant, and invalid indexes

EXAMPLES:
  $ ddlforge advisor analyze --db postgres://localhost/mydb
  $ ddlforge advisor simulate --query "SELECT * FROM users WHERE email = 'test'" --index "CREATE INDEX idx ON users(email)" --db postgres://localhost/mydb
  $ ddlforge advisor prune --db postgres://localhost/mydb --min-size-mb 10
`);
    return 0;
  }

  // Subcommand 1: ddlforge advisor analyze
  if (sub === 'analyze') {
    const subArgs = argv.slice(1);
    let dbUrl = process.env['DATABASE_URL'] ?? '';
    let table = '';
    let schema = 'public';
    let limit = 10;
    let format: 'terminal' | 'json' = 'terminal';

    let i = 0;
    while (i < subArgs.length) {
      const arg = subArgs[i];
      if (arg === '--help' || arg === '-h') {
        console.log(`
ddlforge advisor analyze [options]

Mine table Read/Write ratios, HOT update efficiencies, and pg_stat_statements telemetry.

FLAGS:
  --db <url>          PostgreSQL connection URL (or DATABASE_URL)
  --table <table>     Filter by specific table name (optional)
  --schema <name>     Target PostgreSQL schema (default: public)
  --limit <n>         Max slow queries to display from pg_stat_statements (default: 10)
  --format <type>     Output format: terminal | json (default: terminal)
  --help, -h          Print this help message and exit
`);
        return 0;
      }
      if (arg === '--db') {
        i++;
        if (i < subArgs.length) dbUrl = subArgs[i];
        i++;
        continue;
      }
      if (arg.startsWith('--db=')) {
        dbUrl = arg.slice('--db='.length);
        i++;
        continue;
      }
      if (arg === '--table') {
        i++;
        if (i < subArgs.length) table = subArgs[i];
        i++;
        continue;
      }
      if (arg.startsWith('--table=')) {
        table = arg.slice('--table='.length);
        i++;
        continue;
      }
      if (arg === '--schema') {
        i++;
        if (i < subArgs.length) schema = subArgs[i];
        i++;
        continue;
      }
      if (arg.startsWith('--schema=')) {
        schema = arg.slice('--schema='.length);
        i++;
        continue;
      }
      if (arg === '--limit') {
        i++;
        if (i < subArgs.length) limit = parseInt(subArgs[i], 10) || 10;
        i++;
        continue;
      }
      if (arg.startsWith('--limit=')) {
        limit = parseInt(arg.slice('--limit='.length), 10) || 10;
        i++;
        continue;
      }
      if (arg === '--format') {
        i++;
        if (i < subArgs.length && (subArgs[i] === 'json' || subArgs[i] === 'terminal')) format = subArgs[i] as any;
        i++;
        continue;
      }
      if (arg.startsWith('--format=')) {
        const f = arg.slice('--format='.length);
        if (f === 'json' || f === 'terminal') format = f as any;
        i++;
        continue;
      }
      i++;
    }

    if (!dbUrl) {
      console.error('ddlforge advisor analyze: Missing required database connection URL (--db or DATABASE_URL).');
      return 1;
    }

    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: dbUrl });

    try {
      const { harvestFullWorkloadReport, formatWorkloadReportTerminal } = await import('./advisor/index.js');
      const report = await harvestFullWorkloadReport(pool, {
        schema,
        table: table || undefined,
        limit,
      });

      if (format === 'json') {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(formatWorkloadReportTerminal(report));
      }
      return 0;
    } catch (err: any) {
      console.error(`ddlforge advisor analyze error: ${err.message}`);
      return 1;
    } finally {
      await pool.end().catch(() => {});
    }
  }

  // Subcommand 2: ddlforge advisor simulate
  if (sub === 'simulate') {
    const subArgs = argv.slice(1);
    let dbUrl = process.env['DATABASE_URL'] ?? '';
    let query = '';
    let indexSql = '';
    let format: 'terminal' | 'json' = 'terminal';

    let i = 0;
    while (i < subArgs.length) {
      const arg = subArgs[i];
      if (arg === '--help' || arg === '-h') {
        console.log(`
ddlforge advisor simulate --query <sql> --index <create-index-sql> [options]

Simulate hypothetical index in-memory with hypopg to calculate cost reduction.

FLAGS:
  --db <url>          PostgreSQL connection URL (or DATABASE_URL)
  --query <sql>       SQL query to benchmark with EXPLAIN (FORMAT JSON)
  --index <sql>       CREATE INDEX statement to simulate in-memory
  --format <type>     Output format: terminal | json (default: terminal)
  --help, -h          Print this help message and exit
`);
        return 0;
      }
      if (arg === '--db') {
        i++;
        if (i < subArgs.length) dbUrl = subArgs[i];
        i++;
        continue;
      }
      if (arg.startsWith('--db=')) {
        dbUrl = arg.slice('--db='.length);
        i++;
        continue;
      }
      if (arg === '--query') {
        i++;
        if (i < subArgs.length) query = subArgs[i];
        i++;
        continue;
      }
      if (arg.startsWith('--query=')) {
        query = arg.slice('--query='.length);
        i++;
        continue;
      }
      if (arg === '--index') {
        i++;
        if (i < subArgs.length) indexSql = subArgs[i];
        i++;
        continue;
      }
      if (arg.startsWith('--index=')) {
        indexSql = arg.slice('--index='.length);
        i++;
        continue;
      }
      if (arg === '--format') {
        i++;
        if (i < subArgs.length && (subArgs[i] === 'json' || subArgs[i] === 'terminal')) format = subArgs[i] as any;
        i++;
        continue;
      }
      if (arg.startsWith('--format=')) {
        const f = arg.slice('--format='.length);
        if (f === 'json' || f === 'terminal') format = f as any;
        i++;
        continue;
      }
      i++;
    }

    if (!dbUrl) {
      console.error('ddlforge advisor simulate: Missing required database connection URL (--db or DATABASE_URL).');
      return 1;
    }

    if (!query || !indexSql) {
      console.error('ddlforge advisor simulate: Both --query <sql> and --index <sql> flags are required.');
      return 1;
    }

    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: dbUrl });

    try {
      const { simulateHypotheticalIndex, formatSimulationReportTerminal } = await import('./advisor/index.js');
      const report = await simulateHypotheticalIndex(pool, {
        query,
        createIndexSql: indexSql,
      });

      if (format === 'json') {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(formatSimulationReportTerminal(report));
      }

      return report.recommendation === 'REJECTED_BY_PLANNER' ? 1 : 0;
    } catch (err: any) {
      console.error(`ddlforge advisor simulate error: ${err.message}`);
      return 1;
    } finally {
      await pool.end().catch(() => {});
    }
  }

  // Subcommand 3: ddlforge advisor prune
  if (sub === 'prune') {
    const subArgs = argv.slice(1);
    let dbUrl = process.env['DATABASE_URL'] ?? '';
    let table = '';
    let schema = 'public';
    let minSizeMb = 0;
    let maxScans = 0;
    let executeDrop = false;
    let format: 'terminal' | 'json' = 'terminal';

    let i = 0;
    while (i < subArgs.length) {
      const arg = subArgs[i];
      if (arg === '--help' || arg === '-h') {
        console.log(`
ddlforge advisor prune [options]

Discover unused, prefix-subsumed redundant, and invalid indexes.

FLAGS:
  --db <url>          PostgreSQL connection URL (or DATABASE_URL)
  --table <table>     Filter by specific table name (optional)
  --schema <name>     Target PostgreSQL schema (default: public)
  --min-size-mb <n>   Minimum index size in MB to consider for pruning (default: 0)
  --max-scans <n>     Maximum index scans to qualify as unused (default: 0)
  --drop              Execute DROP INDEX CONCURRENTLY on safe prunable candidates
  --format <type>     Output format: terminal | json (default: terminal)
  --help, -h          Print this help message and exit
`);
        return 0;
      }
      if (arg === '--db') {
        i++;
        if (i < subArgs.length) dbUrl = subArgs[i];
        i++;
        continue;
      }
      if (arg.startsWith('--db=')) {
        dbUrl = arg.slice('--db='.length);
        i++;
        continue;
      }
      if (arg === '--table') {
        i++;
        if (i < subArgs.length) table = subArgs[i];
        i++;
        continue;
      }
      if (arg.startsWith('--table=')) {
        table = arg.slice('--table='.length);
        i++;
        continue;
      }
      if (arg === '--schema') {
        i++;
        if (i < subArgs.length) schema = subArgs[i];
        i++;
        continue;
      }
      if (arg.startsWith('--schema=')) {
        schema = arg.slice('--schema='.length);
        i++;
        continue;
      }
      if (arg === '--min-size-mb') {
        i++;
        if (i < subArgs.length) minSizeMb = parseFloat(subArgs[i]) || 0;
        i++;
        continue;
      }
      if (arg.startsWith('--min-size-mb=')) {
        minSizeMb = parseFloat(arg.slice('--min-size-mb='.length)) || 0;
        i++;
        continue;
      }
      if (arg === '--max-scans') {
        i++;
        if (i < subArgs.length) maxScans = parseInt(subArgs[i], 10) || 0;
        i++;
        continue;
      }
      if (arg.startsWith('--max-scans=')) {
        maxScans = parseInt(arg.slice('--max-scans='.length), 10) || 0;
        i++;
        continue;
      }
      if (arg === '--drop') {
        executeDrop = true;
        i++;
        continue;
      }
      if (arg === '--format') {
        i++;
        if (i < subArgs.length && (subArgs[i] === 'json' || subArgs[i] === 'terminal')) format = subArgs[i] as any;
        i++;
        continue;
      }
      if (arg.startsWith('--format=')) {
        const f = arg.slice('--format='.length);
        if (f === 'json' || f === 'terminal') format = f as any;
        i++;
        continue;
      }
      i++;
    }

    if (!dbUrl) {
      console.error('ddlforge advisor prune: Missing required database connection URL (--db or DATABASE_URL).');
      return 1;
    }

    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: dbUrl });

    try {
      const { queryPrunableIndexes, formatPruneReportTerminal } = await import('./advisor/index.js');
      const report = await queryPrunableIndexes(pool, {
        schema,
        table: table || undefined,
        minSizeMb,
        maxScans,
      });

      if (executeDrop && report.candidates.length > 0) {
        console.log(`[ddlforge advisor prune] Executing concurrent drops for ${report.candidates.length} candidate(s)...`);
        for (const c of report.candidates) {
          if (!c.isSafeToDrop) {
            console.log(`  ⚠ Skipping "${c.indexName}": flagged with caution (${c.safetyWarnings.join('; ')})`);
            continue;
          }
          console.log(`  Executing: ${c.dropSql}`);
          try {
            await pool.query(`SET lock_timeout = '2s';`);
            await pool.query(c.dropSql);
            console.log(`  ✔ Successfully dropped "${c.indexName}".`);
          } catch (dropErr: any) {
            console.error(`  ✖ Failed to drop "${c.indexName}": ${dropErr.message}`);
          }
        }
      }

      if (format === 'json') {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(formatPruneReportTerminal(report));
      }

      return 0;
    } catch (err: any) {
      console.error(`ddlforge advisor prune error: ${err.message}`);
      return 1;
    } finally {
      await pool.end().catch(() => {});
    }
  }

  console.error(`ddlforge advisor: Unknown subcommand "${sub}". Supported subcommands: analyze, simulate, prune.`);
  return 1;
}




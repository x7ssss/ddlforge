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

export const VERSION = '1.2.0';

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

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
// executor is imported dynamically inside runApply() to preserve
// zero-dependency invariant for static linting (ddlforge check).

export interface CliOptions {
  targets: string[];
  pgVersion: number;
  format: 'terminal' | 'json' | 'markdown' | 'sarif';
  quiet: boolean;
  changedOnly: boolean;
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

export const VERSION = '0.3.0';

export function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    targets: [],
    pgVersion: 16,
    format: 'terminal',
    quiet: false,
    changedOnly: false,
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

    if (arg === '--format') {
      i++;
      if (i < args.length) {
        const fmt = args[i].toLowerCase();
        if (fmt === 'json' || fmt === 'markdown' || fmt === 'terminal' || fmt === 'sarif') {
          options.format = fmt;
        }
      }
      i++;
      continue;
    }
    if (arg.startsWith('--format=')) {
      const fmt = arg.slice(9).toLowerCase();
      if (fmt === 'json' || fmt === 'markdown' || fmt === 'terminal' || fmt === 'sarif') {
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
  ddlforge apply <file.sql> --db <url>     # apply a migration safely

── CHECK (lint) ──────────────────────────────────────────────────────
ARGUMENTS:
  paths               Target migration files or directories (e.g. ./prisma/migrations, ./drizzle)

FLAGS:
  --pg <version>      Target PostgreSQL version (default: 16)
  --format <type>     Output format: terminal | json | markdown | sarif (default: terminal)
  --quiet, -q         Suppress advisories/warnings and emit blockers only
  --changed-only      Use git diff to lint only staged or branch-modified migration files
  --version, -v       Print ddlforge version and exit
  --help, -h          Print this help message and exit

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

EXAMPLES:
  $ ddlforge ./prisma/migrations
  $ ddlforge ./drizzle --pg 14 --format json
  $ ddlforge --changed-only
  $ ddlforge ./migrations/001_add_index.sql
  $ ddlforge apply ./migrations/001_add_index.sql --db postgres://localhost/mydb
  $ ddlforge apply ./migrations/001_add_index.sql --db postgres://localhost/mydb --dry-run
  $ ddlforge apply ./migrations/001_add_index.sql --db \$DATABASE_URL --lock-timeout 5000 --max-retries 3
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
    if (options.format === 'json') {
      console.log(formatJson([]));
    } else if (options.format === 'markdown') {
      console.log(formatMarkdown([]));
    } else if (options.format === 'sarif') {
      console.log(formatSarif([]));
    } else {
      console.log('No migration .sql files found to analyze.');
    }
    return 0;
  }

  const analyzer = new MigrationAnalyzer();
  const results: AnalysisResult[] = [];

  for (const file of files) {
    try {
      const content = fs.readFileSync(file, 'utf-8');
      const res = analyzer.analyze(content, {
        filePath: file,
        pgVersion: options.pgVersion,
      });
      results.push(res);
    } catch (err: any) {
      console.error(`Error reading ${file}: ${err?.message ?? String(err)}`);
    }
  }

  // Format and output results
  if (options.format === 'json') {
    console.log(formatJson(results));
  } else if (options.format === 'markdown') {
    console.log(formatMarkdown(results));
  } else if (options.format === 'sarif') {
    console.log(formatSarif(results));
  } else {
    console.log(formatTerminal(results, { quiet: options.quiet }));
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

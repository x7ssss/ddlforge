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

export interface CliOptions {
  targets: string[];
  pgVersion: number;
  format: 'terminal' | 'json' | 'markdown';
  quiet: boolean;
  changedOnly: boolean;
  help: boolean;
  version: boolean;
}

export const VERSION = '1.0.0';

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
        if (fmt === 'json' || fmt === 'markdown' || fmt === 'terminal') {
          options.format = fmt;
        }
      }
      i++;
      continue;
    }
    if (arg.startsWith('--format=')) {
      const fmt = arg.slice(9).toLowerCase();
      if (fmt === 'json' || fmt === 'markdown' || fmt === 'terminal') {
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

EXAMPLES:
  $ ddlforge ./prisma/migrations
  $ ddlforge ./drizzle --pg 14 --format json
  $ ddlforge --changed-only
  $ ddlforge ./migrations/001_add_index.sql
`);
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
  } else {
    console.log(formatTerminal(results, { quiet: options.quiet }));
  }

  const hasBlockers = results.some(r => r.hasBlockers);
  return hasBlockers ? 1 : 0;
}

/**
 * ddlforge - ORM Migration Supervisor (Wrap orchestrator)
 *
 * Intercepts pending migration files (Prisma / Drizzle / custom),
 * runs pre-flight safety analysis, and delegates execution to the
 * underlying migration command.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { MigrationAnalyzer, AnalysisResult } from '../engine/analyzer.js';
import { formatTerminal } from '../reporters/terminal.js';

export interface DiscoveredMigration {
  name: string;
  filePath: string;
  projectType: 'prisma' | 'drizzle' | 'generic';
}

export interface WrapOptions {
  dir?: string;
  allowBlockers?: boolean;
  databaseUrl?: string;
  command: string[];
  help?: boolean;
  cwd?: string;
}

export interface WrapResult {
  success: boolean;
  exitCode: number;
  blockersCount: number;
  warningsCount: number;
  migrationsCount: number;
  executedCommand: boolean;
}

/**
 * Parses arguments for the `wrap` subcommand.
 * argv should be the args after the "wrap" token.
 * E.g. `['--dir=./drizzle', '--', 'npx', 'drizzle-kit', 'migrate']`
 */
export function parseWrapArgs(argv: string[]): WrapOptions {
  const dashDashIdx = argv.indexOf('--');
  const optArgs = dashDashIdx !== -1 ? argv.slice(0, dashDashIdx) : argv;
  const command = dashDashIdx !== -1 ? argv.slice(dashDashIdx + 1) : [];

  const opts: WrapOptions = {
    dir: undefined,
    allowBlockers: false,
    databaseUrl: process.env['DATABASE_URL'] || undefined,
    command,
    help: false,
  };

  let i = 0;
  while (i < optArgs.length) {
    const arg = optArgs[i];

    if (arg === '--help' || arg === '-h') {
      opts.help = true;
      i++;
      continue;
    }

    if (arg === '--allow-blockers') {
      opts.allowBlockers = true;
      i++;
      continue;
    }

    if (arg === '--dir') {
      i++;
      if (i < optArgs.length) {
        opts.dir = optArgs[i];
      }
      i++;
      continue;
    }
    if (arg.startsWith('--dir=')) {
      opts.dir = arg.slice('--dir='.length);
      i++;
      continue;
    }

    if (arg === '--db' || arg === '--database-url') {
      i++;
      if (i < optArgs.length) {
        opts.databaseUrl = optArgs[i];
      }
      i++;
      continue;
    }
    if (arg.startsWith('--db=')) {
      opts.databaseUrl = arg.slice('--db='.length);
      i++;
      continue;
    }
    if (arg.startsWith('--database-url=')) {
      opts.databaseUrl = arg.slice('--database-url='.length);
      i++;
      continue;
    }

    // If no '--' was provided, positional arguments might be the command
    if (dashDashIdx === -1 && !arg.startsWith('-')) {
      opts.command.push(...optArgs.slice(i));
      break;
    }

    i++;
  }

  return opts;
}

/**
 * Scans directories to detect migration files for Prisma, Drizzle, or generic layouts.
 */
export function detectMigrations(dir?: string, cwd: string = process.cwd()): DiscoveredMigration[] {
  // If an explicit directory is provided, scan it
  if (dir) {
    const targetDir = path.isAbsolute(dir) ? dir : path.resolve(cwd, dir);
    if (!fs.existsSync(targetDir)) {
      return [];
    }

    const stat = fs.statSync(targetDir);
    if (stat.isFile() && targetDir.endsWith('.sql')) {
      return [{
        name: path.basename(targetDir),
        filePath: targetDir,
        projectType: 'generic',
      }];
    }

    if (!stat.isDirectory()) {
      return [];
    }

    const entries = fs.readdirSync(targetDir, { withFileTypes: true });

    // Check for Prisma-style subdirectories (each containing migration.sql)
    const prismaMigrations: DiscoveredMigration[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const migrationSql = path.join(targetDir, entry.name, 'migration.sql');
        if (fs.existsSync(migrationSql) && fs.statSync(migrationSql).isFile()) {
          prismaMigrations.push({
            name: entry.name,
            filePath: migrationSql,
            projectType: 'prisma',
          });
        }
      }
    }

    if (prismaMigrations.length > 0) {
      return prismaMigrations.sort((a, b) => a.name.localeCompare(b.name));
    }

    // Flat directory: check for *.sql files
    const sqlFiles: DiscoveredMigration[] = [];
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.sql')) {
        sqlFiles.push({
          name: entry.name,
          filePath: path.join(targetDir, entry.name),
          projectType: 'drizzle',
        });
      }
    }

    if (sqlFiles.length > 0) {
      return sqlFiles.sort((a, b) => a.name.localeCompare(b.name));
    }

    // Recursive search if not found directly
    const recursiveFiles: DiscoveredMigration[] = [];
    collectSqlRecursive(targetDir, recursiveFiles);
    return recursiveFiles.sort((a, b) => a.name.localeCompare(b.name));
  }

  // Auto-detection when --dir is not provided:
  // 1. Prisma migrations (prisma/migrations/*/migration.sql)
  const prismaDir = path.join(cwd, 'prisma', 'migrations');
  if (fs.existsSync(prismaDir) && fs.statSync(prismaDir).isDirectory()) {
    const entries = fs.readdirSync(prismaDir, { withFileTypes: true });
    const migrations: DiscoveredMigration[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const mPath = path.join(prismaDir, entry.name, 'migration.sql');
        if (fs.existsSync(mPath) && fs.statSync(mPath).isFile()) {
          migrations.push({
            name: entry.name,
            filePath: mPath,
            projectType: 'prisma',
          });
        }
      }
    }
    if (migrations.length > 0) {
      return migrations.sort((a, b) => a.name.localeCompare(b.name));
    }
  }

  // 2. Drizzle migrations (drizzle/*.sql)
  const drizzleDir = path.join(cwd, 'drizzle');
  if (fs.existsSync(drizzleDir) && fs.statSync(drizzleDir).isDirectory()) {
    const entries = fs.readdirSync(drizzleDir, { withFileTypes: true });
    const migrations: DiscoveredMigration[] = [];
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.sql')) {
        migrations.push({
          name: entry.name,
          filePath: path.join(drizzleDir, entry.name),
          projectType: 'drizzle',
        });
      }
    }
    if (migrations.length > 0) {
      return migrations.sort((a, b) => a.name.localeCompare(b.name));
    }
  }

  // 3. Generic migrations (migrations/*.sql or migrations/*/migration.sql)
  const migrationsDir = path.join(cwd, 'migrations');
  if (fs.existsSync(migrationsDir) && fs.statSync(migrationsDir).isDirectory()) {
    const entries = fs.readdirSync(migrationsDir, { withFileTypes: true });
    const prismaStyle: DiscoveredMigration[] = [];
    const flatStyle: DiscoveredMigration[] = [];

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const mPath = path.join(migrationsDir, entry.name, 'migration.sql');
        if (fs.existsSync(mPath) && fs.statSync(mPath).isFile()) {
          prismaStyle.push({
            name: entry.name,
            filePath: mPath,
            projectType: 'prisma',
          });
        }
      } else if (entry.isFile() && entry.name.endsWith('.sql')) {
        flatStyle.push({
          name: entry.name,
          filePath: path.join(migrationsDir, entry.name),
          projectType: 'generic',
        });
      }
    }

    if (prismaStyle.length > 0) {
      return prismaStyle.sort((a, b) => a.name.localeCompare(b.name));
    }
    if (flatStyle.length > 0) {
      return flatStyle.sort((a, b) => a.name.localeCompare(b.name));
    }
  }

  return [];
}

function collectSqlRecursive(dir: string, accumulator: DiscoveredMigration[]): void {
  const IGNORED = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.turbo']);
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!IGNORED.has(entry.name)) {
        collectSqlRecursive(path.join(dir, entry.name), accumulator);
      }
    } else if (entry.isFile() && entry.name.endsWith('.sql')) {
      accumulator.push({
        name: entry.name,
        filePath: path.join(dir, entry.name),
        projectType: 'generic',
      });
    }
  }
}

/**
 * Connects to PostgreSQL and queries applied migration tables (_prisma_migrations or __drizzle_migrations).
 * Returns the filtered set of pending (unapplied) migrations.
 */
export async function filterPendingMigrations(
  migrations: DiscoveredMigration[],
  databaseUrl?: string
): Promise<DiscoveredMigration[]> {
  if (!databaseUrl || migrations.length === 0) {
    return migrations;
  }

  try {
    const pg = await import('pg');
    const Client = pg.default?.Client ?? (pg as unknown as { Client: new (opts: { connectionString: string; connectionTimeoutMillis: number }) => any }).Client;
    const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 3000 });
    await client.connect();

    try {
      const applied = new Set<string>();

      // Check _prisma_migrations
      try {
        const res = await client.query('SELECT migration_name FROM _prisma_migrations WHERE rolled_back_at IS NULL');
        for (const row of res.rows) {
          if (row.migration_name) applied.add(String(row.migration_name).trim());
        }
      } catch {
        // Table does not exist, ignore
      }

      // Check __drizzle_migrations in public or drizzle schema
      for (const tbl of ['"__drizzle_migrations"', '"drizzle"."__drizzle_migrations"']) {
        try {
          const res = await client.query(`SELECT * FROM ${tbl}`);
          for (const row of res.rows) {
            if (row.created_at != null) applied.add(String(row.created_at).trim());
            if (row.hash) applied.add(String(row.hash).trim());
            if (row.name) applied.add(String(row.name).trim());
            if (row.migration_name) applied.add(String(row.migration_name).trim());
          }
          break;
        } catch {
          // Table does not exist, ignore
        }
      }

      if (applied.size === 0) {
        return migrations;
      }

      return migrations.filter(m => {
        if (applied.has(m.name)) return false;
        const baseName = path.basename(m.name, '.sql');
        if (applied.has(baseName)) return false;

        // Check sha256 hash
        try {
          const content = fs.readFileSync(m.filePath, 'utf-8');
          const hash = crypto.createHash('sha256').update(content).digest('hex');
          if (applied.has(hash)) return false;
        } catch {}

        // Check timestamp prefix (e.g. 20260916 in 20260916_init)
        const parts = m.name.split('_');
        if (parts.length > 1 && applied.has(parts[0])) return false;

        return true;
      });
    } finally {
      await client.end().catch(() => {});
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[ddlforge wrap] Warning: Could not query database for applied migrations (${msg}). Checking all discovered migrations.`);
    return migrations;
  }
}

/**
 * Runs ddlforge rules against candidate migration files.
 */
export function runPreflightCheck(migrations: DiscoveredMigration[]): AnalysisResult[] {
  const analyzer = new MigrationAnalyzer();
  const results: AnalysisResult[] = [];

  for (const migration of migrations) {
    try {
      const content = fs.readFileSync(migration.filePath, 'utf-8');
      const isPrisma = migration.projectType === 'prisma';
      const res = analyzer.analyze(content, {
        filePath: migration.filePath,
        isPrismaMigration: isPrisma,
        pgVersion: 16,
      });
      results.push(res);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[ddlforge wrap] Error reading migration ${migration.filePath}: ${msg}`);
    }
  }

  return results;
}

/**
 * Spawns the user migration command as a child process with inherited stdio.
 */
export function spawnCommand(command: string[], cwd: string = process.cwd()): Promise<number> {
  return new Promise((resolve) => {
    if (command.length === 0) {
      resolve(0);
      return;
    }

    const isWindows = process.platform === 'win32';
    const isDirectExecutable = command[0] === 'node' || command[0].endsWith('.exe') || (!isWindows && !command[0].includes(' '));

    let child;
    if (isDirectExecutable) {
      child = spawn(command[0], command.slice(1), {
        stdio: 'inherit',
        shell: false,
        cwd,
      });
    } else {
      // Use shell for commands like `npx`, `npm`, `drizzle-kit` on Windows.
      // Passing a single string avoids Node 22+ DEP0190 warning.
      const cmdLine = command.join(' ');
      child = spawn(cmdLine, {
        stdio: 'inherit',
        shell: true,
        cwd,
      });
    }

    const onSIGINT  = () => { child.kill('SIGINT');  process.exit(130); };
    const onSIGTERM = () => { child.kill('SIGTERM'); process.exit(143); };
    process.once('SIGINT',  onSIGINT);
    process.once('SIGTERM', onSIGTERM);

    child.on('close', (code, signal) => {
      process.off('SIGINT',  onSIGINT);
      process.off('SIGTERM', onSIGTERM);
      if (signal) {
        resolve(1);
      } else {
        resolve(code ?? 0);
      }
    });

    child.on('error', (err) => {
      process.off('SIGINT',  onSIGINT);
      process.off('SIGTERM', onSIGTERM);
      console.error(`[ddlforge wrap] Failed to execute command "${command.join(' ')}": ${err.message}`);
      resolve(1);
    });
  });
}

/**
 * Main orchestrator workflow for `ddlforge wrap`.
 */
export async function orchestrateWrap(options: WrapOptions): Promise<WrapResult> {
  const cwd = options.cwd ?? process.cwd();

  // 1. Auto-detection & extraction of migration files
  const allMigrations = detectMigrations(options.dir, cwd);

  // 2. Filter pending migrations against DB schema if accessible
  const pending = await filterPendingMigrations(allMigrations, options.databaseUrl);

  // If no migrations are found, proceed directly to running the command
  if (pending.length === 0) {
    console.log('[ddlforge wrap] No pending migrations found to check. Proceeding with command...');
    const exitCode = await spawnCommand(options.command, cwd);
    return {
      success: exitCode === 0,
      exitCode,
      blockersCount: 0,
      warningsCount: 0,
      migrationsCount: 0,
      executedCommand: true,
    };
  }

  // 3. Pre-flight safety check
  const results = runPreflightCheck(pending);
  const blockersCount = results.reduce((sum, r) => sum + r.blockersCount, 0);
  const warningsCount = results.reduce((sum, r) => sum + r.warningsCount, 0);

  if (blockersCount > 0) {
    // Output blocker diagnostics and remediation recipes
    console.log(formatTerminal(results));

    if (!options.allowBlockers) {
      console.error(
        `\n[ddlforge wrap] Pre-flight safety check failed: ${blockersCount} blocker(s) found. Aborting before running command.`
      );
      return {
        success: false,
        exitCode: 1,
        blockersCount,
        warningsCount,
        migrationsCount: pending.length,
        executedCommand: false,
      };
    } else {
      console.warn(
        `\n[ddlforge wrap] Warning: ${blockersCount} blocker(s) detected, but --allow-blockers is set. Proceeding with command.`
      );
    }
  } else {
    if (warningsCount > 0) {
      console.log(formatTerminal(results));
    }
    console.log(
      `[ddlforge wrap] Pre-flight safety check passed (${pending.length} migration(s) verified). Running command...\n`
    );
  }

  // 4. Execution delegation
  const exitCode = await spawnCommand(options.command, cwd);
  return {
    success: exitCode === 0,
    exitCode,
    blockersCount,
    warningsCount,
    migrationsCount: pending.length,
    executedCommand: true,
  };
}

export function printWrapHelp(): void {
  console.log(`
ddlforge wrap — Supervise ORM migration deployments with pre-flight safety checks

USAGE:
  ddlforge wrap [options] -- <command...>

ARGUMENTS:
  <command...>        Migration deployment command to run after safety checks

FLAGS:
  --dir <path>        Migration directory to scan (defaults: auto-detect prisma/migrations, drizzle, or ./migrations)
  --allow-blockers    Warn on blockers instead of aborting the command
  --db <url>          Database URL for pending migration checks (falls back to DATABASE_URL)
  --help, -h          Print this help message and exit

EXAMPLES:
  $ ddlforge wrap -- npx prisma migrate deploy
  $ ddlforge wrap --dir=./drizzle -- npx drizzle-kit migrate
  $ ddlforge wrap --allow-blockers -- npm run migrate
`);
}

/**
 * CLI entry point for the `wrap` subcommand.
 */
export async function runWrap(argv: string[], cwd: string = process.cwd()): Promise<number> {
  const options = parseWrapArgs(argv);

  if (options.help) {
    printWrapHelp();
    return 0;
  }

  if (options.command.length === 0) {
    console.error('ddlforge wrap: Missing command after "--".');
    console.error('Usage: ddlforge wrap [options] -- <command...>');
    console.error('Example: ddlforge wrap -- npx prisma migrate deploy');
    return 1;
  }

  const result = await orchestrateWrap({ ...options, cwd });
  return result.exitCode;
}

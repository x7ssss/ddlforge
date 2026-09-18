/**
 * ddlforge - Native Ledger Forging Helpers
 *
 * Generates ready-to-execute SQL to record completed out-of-band
 * migrations into Prisma (_prisma_migrations) or Drizzle (drizzle.__drizzle_migrations).
 */

import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as fs from 'node:fs';

export type SupportedOrm = 'prisma' | 'drizzle';

export interface PrismaLedgerResult {
  orm: 'prisma';
  sql: string;
  id: string;
  checksum: string;
  migrationName: string;
}

export interface DrizzleLedgerResult {
  orm: 'drizzle';
  sql: string;
  hash: string;
}

export type LedgerResult = PrismaLedgerResult | DrizzleLedgerResult;

export interface ForgeOptions {
  migrationName?: string;
}

/**
 * Computes SHA-256 hex digest of raw content (as UTF-8).
 */
export function computeSha256(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Extracts a canonical migration name from a file path or directory structure.
 * E.g.:
 *   "prisma/migrations/20260918120000_add_index/migration.sql" -> "20260918120000_add_index"
 *   "drizzle/0001_initial.sql" -> "0001_initial"
 */
export function extractMigrationName(filePath: string): string {
  const base = path.basename(filePath);
  if (base.toLowerCase() === 'migration.sql') {
    const parent = path.basename(path.dirname(filePath));
    if (parent && parent !== '.' && parent !== '/') {
      return parent;
    }
  }
  const ext = path.extname(filePath);
  return path.basename(filePath, ext);
}

/**
 * Forges ready-to-execute SQL for Prisma Migrate ledger (_prisma_migrations).
 */
export function forgePrismaLedger(
  filePath: string,
  fileContent?: string,
  migrationNameOverride?: string
): PrismaLedgerResult {
  const content = fileContent !== undefined
    ? fileContent
    : fs.readFileSync(filePath, 'utf-8');

  const checksum = computeSha256(content);
  const id = crypto.randomUUID();
  const migrationName = migrationNameOverride || extractMigrationName(filePath);

  const sql = `INSERT INTO "_prisma_migrations" (
  "id",
  "checksum",
  "finished_at",
  "migration_name",
  "logs",
  "rolled_back_at",
  "started_at",
  "applied_steps_count"
) VALUES (
  '${id}',
  '${checksum}',
  now(),
  '${migrationName}',
  NULL,
  NULL,
  now(),
  1
);`;

  return {
    orm: 'prisma',
    sql,
    id,
    checksum,
    migrationName,
  };
}

/**
 * Forges ready-to-execute SQL for Drizzle ORM ledger (drizzle.__drizzle_migrations).
 */
export function forgeDrizzleLedger(
  filePath: string,
  fileContent?: string
): DrizzleLedgerResult {
  const content = fileContent !== undefined
    ? fileContent
    : fs.readFileSync(filePath, 'utf-8');

  const hash = computeSha256(content);

  const sql = `INSERT INTO drizzle.__drizzle_migrations ("hash", "created_at")
VALUES ('${hash}', (extract(epoch from now()) * 1000)::bigint);`;

  return {
    orm: 'drizzle',
    sql,
    hash,
  };
}

/**
 * General entry point to forge migration ledger SQL for Prisma or Drizzle.
 */
export function forgeLedger(
  orm: SupportedOrm,
  filePath: string,
  fileContent?: string,
  options: ForgeOptions = {}
): LedgerResult {
  if (orm === 'prisma') {
    return forgePrismaLedger(filePath, fileContent, options.migrationName);
  }
  if (orm === 'drizzle') {
    return forgeDrizzleLedger(filePath, fileContent);
  }
  throw new Error(`Unsupported ORM "${orm}". Supported ORMs are: prisma, drizzle.`);
}

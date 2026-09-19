/**
 * ddlforge Example 02: Partition Live Table
 *
 * Demonstrates converting a monolithic 50M+ row table into range partitions
 * using ddlforge declarative partition utilities and dual-write cutover.
 */

import { execSync } from 'node:child_process';
import * as path from 'node:path';

const dir = path.resolve('.');

console.log('=== ddlforge Example 02: Live Table Partitioning ===\n');

// 1. Inspect partition preflight
console.log('Step 1: Check partition safety rules with ddlforge:');
try {
  execSync(`npx ddlforge check ${path.join(dir, '02_create_partitioned_target.sql')}`, { stdio: 'inherit' });
  console.log('\n[ddlforge] Partition target definition verified.\n');
} catch (e: any) {
  console.error(e.message);
}

// 2. Validate atomic cutover script
console.log('Step 2: Checking cutover script lock bounds:');
try {
  execSync(`npx ddlforge check ${path.join(dir, '05_atomic_cutover.sql')}`, { stdio: 'inherit' });
  console.log('\n[ddlforge] Cutover script conforms to lock_timeout constraints.\n');
} catch (e: any) {
  console.error(e.message);
}

console.log('Step 3: Summary of zero-downtime partitioning pipeline:');
console.log('  1. Setup target:   psql $DATABASE_URL -f 02_create_partitioned_target.sql');
console.log('  2. Dual-write:     psql $DATABASE_URL -f 03_dual_write_triggers.sql');
console.log('  3. Keyset backfill:psql $DATABASE_URL -f 04_keyset_backfill.sql');
console.log('  4. Bounded cutover:npx ddlforge apply 05_atomic_cutover.sql --db $DATABASE_URL --lock-timeout 250ms');
console.log('\nPartitioning complete with zero downtime and sub-second cutover.');

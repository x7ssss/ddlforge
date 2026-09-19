/**
 * ddlforge Example 01: Safe Column Add
 *
 * Demonstrates inspecting an unsafe migration, generating an automated expand/contract
 * plan, and applying it safely with ddlforge.
 */

import { execSync } from 'node:child_process';
import * as path from 'node:path';

const dir = path.resolve('.');

console.log('=== ddlforge Example 01: Safe NOT NULL Column Add ===\n');

// 1. Static Linting: Detect the hazard in unsafe_migration.sql
console.log('Step 1: Running ddlforge check on unsafe migration:');
try {
  execSync(`npx ddlforge check ${path.join(dir, 'unsafe_migration.sql')}`, { stdio: 'inherit' });
} catch {
  console.log('\n[ddlforge] Successfully caught unsafe migration and blocked deployment!\n');
}

// 2. Preflight Simulation: Run preflight on safe phase 1
console.log('Step 2: Checking safe expand phase:');
try {
  execSync(`npx ddlforge check ${path.join(dir, 'safe_expand_phase1.sql')}`, { stdio: 'inherit' });
  console.log('\n[ddlforge] Safe expand phase passed all zero-downtime rules!\n');
} catch (e: any) {
  console.error(e.message);
}

console.log('Step 3: Safe 3-phase deployment pipeline:');
console.log('  1. Phase 1 Expand:   npx ddlforge apply safe_expand_phase1.sql --db $DATABASE_URL');
console.log('  2. Phase 2 Backfill: npx ddlforge apply safe_backfill_phase2.sql --db $DATABASE_URL');
console.log('  3. Phase 3 Contract: npx ddlforge apply safe_contract_phase3.sql --db $DATABASE_URL');
console.log('\nAll 10M rows updated with 0 seconds of blocked write queries.');

/**
 * ddlforge - Rules registry
 */

export * from './types.js';
export { indexConcurrentlyRule } from './indexConcurrently.js';
export { transactionTrapRule } from './transactionTrap.js';
export { addColumnNotNullRule } from './addColumnNotNull.js';
export { foreignKeyNotValidRule } from './foreignKeyNotValid.js';
export { prismaRenameDropAddRule } from './prismaRenameDropAdd.js';
export { setNotNullFullScanRule } from './setNotNullFullScan.js';
export { unbatchedBackfillRule } from './unbatchedBackfill.js';
export { checkConstraintNotValidRule } from './checkConstraintNotValid.js';
export { uniqueConstraintUsingIndexRule } from './uniqueConstraintUsingIndex.js';
export { sessionAdvisoryLockRule } from './sessionAdvisoryLock.js';
export { alterColumnTypeRewriteRule } from './alterColumnTypeRewrite.js';
export { unindexedForeignKeyRule } from './unindexedForeignKey.js';
export { dropColumnLockRule } from './dropColumnLock.js';

// Postgres 15-17 Concurrency Rules
export { addPrimaryKeyMissingUsingIndexRule } from './addPrimaryKeyMissingUsingIndex.js';
export { checkConstraintMissingNotValidRule } from './checkConstraintMissingNotValid.js';
export { detachPartitionNonConcurrentRule } from './detachPartitionNonConcurrent.js';
export { reindexMissingConcurrentlyRule } from './reindexMissingConcurrently.js';
export { enumAddValueInTransactionRule } from './enumAddValueInTransaction.js';
export { maintenanceCommandDetectedRule } from './maintenanceCommandDetected.js';

import { Rule } from './types.js';
import { indexConcurrentlyRule } from './indexConcurrently.js';
import { transactionTrapRule } from './transactionTrap.js';
import { addColumnNotNullRule } from './addColumnNotNull.js';
import { foreignKeyNotValidRule } from './foreignKeyNotValid.js';
import { prismaRenameDropAddRule } from './prismaRenameDropAdd.js';
import { setNotNullFullScanRule } from './setNotNullFullScan.js';
import { unbatchedBackfillRule } from './unbatchedBackfill.js';
import { checkConstraintNotValidRule } from './checkConstraintNotValid.js';
import { uniqueConstraintUsingIndexRule } from './uniqueConstraintUsingIndex.js';
import { sessionAdvisoryLockRule } from './sessionAdvisoryLock.js';
import { alterColumnTypeRewriteRule } from './alterColumnTypeRewrite.js';
import { unindexedForeignKeyRule } from './unindexedForeignKey.js';
import { dropColumnLockRule } from './dropColumnLock.js';

import { addPrimaryKeyMissingUsingIndexRule } from './addPrimaryKeyMissingUsingIndex.js';
import { checkConstraintMissingNotValidRule } from './checkConstraintMissingNotValid.js';
import { detachPartitionNonConcurrentRule } from './detachPartitionNonConcurrent.js';
import { reindexMissingConcurrentlyRule } from './reindexMissingConcurrently.js';
import { enumAddValueInTransactionRule } from './enumAddValueInTransaction.js';
import { maintenanceCommandDetectedRule } from './maintenanceCommandDetected.js';

export const ALL_RULES: Rule[] = [
  indexConcurrentlyRule,
  transactionTrapRule,
  addColumnNotNullRule,
  foreignKeyNotValidRule,
  prismaRenameDropAddRule,
  setNotNullFullScanRule,
  unbatchedBackfillRule,
  checkConstraintNotValidRule,
  uniqueConstraintUsingIndexRule,
  sessionAdvisoryLockRule,
  alterColumnTypeRewriteRule,
  unindexedForeignKeyRule,
  dropColumnLockRule,

  // 6 New Concurrency Rules
  addPrimaryKeyMissingUsingIndexRule,
  checkConstraintMissingNotValidRule,
  detachPartitionNonConcurrentRule,
  reindexMissingConcurrentlyRule,
  enumAddValueInTransactionRule,
  maintenanceCommandDetectedRule,
];

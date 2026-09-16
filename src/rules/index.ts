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

import { Rule } from './types.js';
import { indexConcurrentlyRule } from './indexConcurrently.js';
import { transactionTrapRule } from './transactionTrap.js';
import { addColumnNotNullRule } from './addColumnNotNull.js';
import { foreignKeyNotValidRule } from './foreignKeyNotValid.js';
import { prismaRenameDropAddRule } from './prismaRenameDropAdd.js';
import { setNotNullFullScanRule } from './setNotNullFullScan.js';
import { unbatchedBackfillRule } from './unbatchedBackfill.js';

export const ALL_RULES: Rule[] = [
  indexConcurrentlyRule,
  transactionTrapRule,
  addColumnNotNullRule,
  foreignKeyNotValidRule,
  prismaRenameDropAddRule,
  setNotNullFullScanRule,
  unbatchedBackfillRule,
];

/**
 * ddlforge - Rule engine types, Finding, and Context interfaces
 */

import { Statement } from '../lexer/tokens.js';
import { PostgresLockLevel } from '../engine/locks.js';

export type Severity = 'BLOCKER' | 'WARNING' | 'ADVISORY';

export interface Finding {
  ruleId: string;
  ruleName: string;
  severity: Severity;
  lockLevel: PostgresLockLevel;
  message: string;
  detail: string;
  suggestion: string;
  file: string;
  line: number;
  column: number;
  codeSnippet: string;
  remediation?: string;
}

export interface RuleContext {
  filePath: string;
  fileContent: string;
  pgVersion: number;
  statements: Statement[];
  isPrismaMigration: boolean;
  hasFilePrismaNoTransaction: boolean;
  activeRuleIds?: Set<string>;
}

export interface Rule {
  id: string;
  name: string;
  description: string;
  defaultSeverity: Severity;
  lockLevel: PostgresLockLevel;
  check(context: RuleContext): Finding[];
}

/**
 * ddlforge - AST-lite IR builder & rule pipeline
 */

import { splitStatements } from '../lexer/sqlTokenizer.js';
import { Statement } from '../lexer/tokens.js';
import { Finding, Rule, RuleContext } from '../rules/types.js';
import { ALL_RULES } from '../rules/index.js';
import { PostgresLockLevel } from './locks.js';
import { processWaivers, WaiverOptions } from './waivers.js';
import { attachRemediations } from './remediation.js';

export interface AnalyzerOptions extends WaiverOptions {
  filePath?: string;
  pgVersion?: number;
  rules?: Rule[];
  isPrismaMigration?: boolean;
  ruleConfig?: Record<string, string | boolean>;
  currentDate?: Date;
}

export interface AnalysisResult {
  file: string;
  statementsAnalyzed: number;
  findings: Finding[];
  suppressedFindings: Finding[];
  allFindings?: Finding[];
  blockersCount: number;
  warningsCount: number;
  advisoriesCount: number;
  durationMs: number;
  hasBlockers: boolean;
  exitCode: number;
}

/**
 * Maps configured rule severity/enablement overrides from .ddlforgerc.json
 * to detected findings. Supports rule IDs, aliases, and lock-level rules.
 */
export function applyRuleConfig(
  findings: Finding[],
  ruleConfig: Record<string, string | boolean>
): Finding[] {
  const result: Finding[] = [];

  const aliasMap: Record<string, string[]> = {
    'non-concurrent-index': ['require-concurrent-index'],
    'require-concurrent-index': ['non-concurrent-index'],
    'unvalidated-foreign-key': ['foreign-key-missing-not-valid', 'foreign-key-not-valid'],
    'foreign-key-missing-not-valid': ['unvalidated-foreign-key', 'foreign-key-not-valid'],
    'foreign-key-not-valid': ['unvalidated-foreign-key', 'foreign-key-missing-not-valid'],
    'add-column-not-null': ['add-column-not-null-without-default'],
    'add-column-not-null-without-default': ['add-column-not-null'],
    'check-constraint-not-valid': ['check-constraint-missing-not-valid'],
    'check-constraint-missing-not-valid': ['check-constraint-not-valid'],
  };

  function findConfigValue(finding: Finding): string | boolean | undefined {
    // 1. Exact match on ruleId
    if (ruleConfig[finding.ruleId] !== undefined) {
      return ruleConfig[finding.ruleId];
    }

    // 2. Case-insensitive key match
    const lowerRuleId = finding.ruleId.toLowerCase();
    for (const [key, val] of Object.entries(ruleConfig)) {
      if (key.toLowerCase() === lowerRuleId) return val;
    }

    // 3. Known aliases
    for (const [key, val] of Object.entries(ruleConfig)) {
      const aliases = aliasMap[key.toLowerCase()];
      if (aliases && aliases.map(a => a.toLowerCase()).includes(lowerRuleId)) {
        return val;
      }
    }

    // 4. Lock-level rule override: e.g. "lock-access-exclusive": "error"
    if (finding.lockLevel === PostgresLockLevel.ACCESS_EXCLUSIVE) {
      if (ruleConfig['lock-access-exclusive'] !== undefined) return ruleConfig['lock-access-exclusive'];
      if (ruleConfig['lock_access_exclusive'] !== undefined) return ruleConfig['lock_access_exclusive'];
      if (ruleConfig['access-exclusive'] !== undefined) return ruleConfig['access-exclusive'];
    }

    return undefined;
  }

  for (const finding of findings) {
    const cfg = findConfigValue(finding);
    if (cfg === undefined) {
      result.push(finding);
      continue;
    }

    const strVal = String(cfg).toLowerCase();
    if (strVal === 'off' || strVal === 'false' || strVal === '0') {
      // Discard disabled rule finding
      continue;
    }

    let newSeverity = finding.severity;
    if (strVal === 'error' || strVal === 'blocker') {
      newSeverity = 'BLOCKER';
    } else if (strVal === 'warn' || strVal === 'warning') {
      newSeverity = 'WARNING';
    } else if (strVal === 'advisory' || strVal === 'info' || strVal === 'note') {
      newSeverity = 'ADVISORY';
    }

    result.push({
      ...finding,
      severity: newSeverity,
    });
  }

  return result;
}

export class MigrationAnalyzer {
  private readonly rules: Rule[];

  constructor(rules: Rule[] = ALL_RULES) {
    this.rules = rules;
  }

  public analyze(sql: string, options: AnalyzerOptions = {}): AnalysisResult {
    if (sql.charCodeAt(0) === 0xFEFF) {
      sql = sql.slice(1);
    }
    const startTime = performance.now();
    const filePath = options.filePath ?? 'anonymous.sql';
    const pgVersion = options.pgVersion ?? 16;

    // Split statements single-pass
    const statements: Statement[] = splitStatements(sql);

    // Prisma migration detection
    const isPrisma = options.isPrismaMigration ?? this.detectIsPrisma(filePath, sql);
    const hasFilePrismaNoTransaction = this.detectPrismaNoTransaction(sql);

    const context: RuleContext = {
      filePath,
      fileContent: sql,
      pgVersion,
      statements,
      isPrismaMigration: isPrisma,
      hasFilePrismaNoTransaction,
      activeRuleIds: new Set(this.rules.map(r => r.id)),
    };

    let rawFindings: Finding[] = [];

    for (const rule of this.rules) {
      const ruleFindings = rule.check(context);
      rawFindings.push(...ruleFindings);
    }

    // Attach zero-downtime remediations for any finding missing one
    attachRemediations(rawFindings, statements);

    // Apply declarative config rule overrides (.ddlforgerc.json)
    if (options.ruleConfig) {
      rawFindings = applyRuleConfig(rawFindings, options.ruleConfig);
    }

    // Apply inline waivers (-- ddlforge-disable-next-line ...)
    const { activeFindings, suppressedFindings } = processWaivers(
      statements,
      rawFindings,
      {
        filePath,
        currentDate: options.currentDate,
      }
    );

    // Sort active findings by line and column
    activeFindings.sort((a, b) => {
      if (a.line !== b.line) return a.line - b.line;
      return a.column - b.column;
    });

    const blockersCount = activeFindings.filter(f => f.severity === 'BLOCKER').length;
    const warningsCount = activeFindings.filter(f => f.severity === 'WARNING').length;
    const advisoriesCount = activeFindings.filter(f => f.severity === 'ADVISORY').length;
    const durationMs = Math.round((performance.now() - startTime) * 100) / 100;
    const hasBlockers = blockersCount > 0;

    return {
      file: filePath,
      statementsAnalyzed: statements.length,
      findings: activeFindings,
      suppressedFindings,
      allFindings: [...activeFindings, ...suppressedFindings],
      blockersCount,
      warningsCount,
      advisoriesCount,
      durationMs,
      hasBlockers,
      exitCode: hasBlockers ? 1 : 0,
    };
  }

  private detectIsPrisma(filePath: string, content: string): boolean {
    const normalizedPath = filePath.replace(/\\/g, '/').toLowerCase();
    if (normalizedPath.includes('prisma/migrations') || normalizedPath.includes('prisma/')) {
      return true;
    }
    // Prisma generator markers
    if (/--\s*(CreateTable|AlterTable|DropTable|CreateIndex|DropIndex|RedefineTables)/.test(content)) {
      return true;
    }
    return false;
  }

  private detectPrismaNoTransaction(content: string): boolean {
    // Detect -- prisma:no-transaction or -- prisma-no-transaction on its own directive line
    return /^\s*--\s*prisma[:\-]no-transaction\s*$/im.test(content);
  }
}

export function analyzeSql(sql: string, options?: AnalyzerOptions): AnalysisResult {
  const analyzer = new MigrationAnalyzer(options?.rules);
  return analyzer.analyze(sql, options);
}

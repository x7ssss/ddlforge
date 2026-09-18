/**
 * ddlforge - AST-lite IR builder & rule pipeline
 */

import { splitStatements } from '../lexer/sqlTokenizer.js';
import { Statement } from '../lexer/tokens.js';
import { Finding, Rule, RuleContext } from '../rules/types.js';
import { ALL_RULES } from '../rules/index.js';

export interface AnalyzerOptions {
  filePath?: string;
  pgVersion?: number;
  rules?: Rule[];
  isPrismaMigration?: boolean;
}

export interface AnalysisResult {
  file: string;
  statementsAnalyzed: number;
  findings: Finding[];
  blockersCount: number;
  warningsCount: number;
  advisoriesCount: number;
  durationMs: number;
  hasBlockers: boolean;
  exitCode: number;
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

    const findings: Finding[] = [];

    for (const rule of this.rules) {
      const ruleFindings = rule.check(context);
      findings.push(...ruleFindings);
    }

    // Sort findings by line and column
    findings.sort((a, b) => {
      if (a.line !== b.line) return a.line - b.line;
      return a.column - b.column;
    });

    const blockersCount = findings.filter(f => f.severity === 'BLOCKER').length;
    const warningsCount = findings.filter(f => f.severity === 'WARNING').length;
    const advisoriesCount = findings.filter(f => f.severity === 'ADVISORY').length;
    const durationMs = Math.round((performance.now() - startTime) * 100) / 100;
    const hasBlockers = blockersCount > 0;

    return {
      file: filePath,
      statementsAnalyzed: statements.length,
      findings,
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

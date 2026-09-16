/**
 * ddlforge - Machine-readable JSON output reporter
 */

import { AnalysisResult } from '../engine/analyzer.js';
import { Finding } from '../rules/types.js';

export interface JsonReport {
  status: 'passed' | 'failed';
  summary: {
    filesScanned: number;
    statementsAnalyzed: number;
    blockers: number;
    warnings: number;
    advisories: number;
    durationMs: number;
    passed: boolean;
  };
  findings: Finding[];
}

export function formatJson(results: AnalysisResult[], pretty: boolean = true): string {
  let filesScanned = results.length;
  let statementsAnalyzed = 0;
  let blockers = 0;
  let warnings = 0;
  let advisories = 0;
  let durationMs = 0;
  const allFindings: Finding[] = [];

  for (const res of results) {
    statementsAnalyzed += res.statementsAnalyzed;
    blockers += res.blockersCount;
    warnings += res.warningsCount;
    advisories += res.advisoriesCount;
    durationMs += res.durationMs;
    allFindings.push(...res.findings);
  }

  const report: JsonReport = {
    status: blockers === 0 ? 'passed' : 'failed',
    summary: {
      filesScanned,
      statementsAnalyzed,
      blockers,
      warnings,
      advisories,
      durationMs: Math.round(durationMs * 100) / 100,
      passed: blockers === 0,
    },
    findings: allFindings,
  };

  return pretty ? JSON.stringify(report, null, 2) : JSON.stringify(report);
}

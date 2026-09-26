/**
 * ddlforge - GitHub Actions Workflow Commands reporter
 *
 * Formats diagnostics as GitHub Actions annotation commands:
 *   ::error file={f},line={l},title=Dangerous Lock ({ruleId})::{message}
 *   ::warning file={f},line={l},title=Dangerous Lock ({ruleId})::{message}
 *
 * Also provides GITHUB_STEP_SUMMARY table generation with:
 *   File, Line, Statement, Lock Type, Downtime Risk, Recommended Fix
 *
 * Reference: https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/workflow-commands-for-github-actions
 */

import * as fs from 'node:fs';
import { AnalysisResult } from '../engine/analyzer.js';
import { Finding } from '../rules/types.js';
import { PostgresLockLevel } from '../engine/locks.js';

export interface GithubReporterOptions {
  /** If true, also emit a ::notice for advisory findings (default: false) */
  emitAdvisories?: boolean;
  /** If true, uses standard title "Dangerous Lock ({ruleId})" without col property */
  dangerousLockTitle?: boolean;
  /** If true, includes recommended safe fix remediation snippet */
  suggestFix?: boolean;
}

export interface StepSummaryOptions {
  /** If true, includes recommended safe fix codeblock in summary */
  suggestFix?: boolean;
}

/**
 * Escapes special characters that are reserved in GitHub Actions workflow
 * command property values: commas, colons, percent signs, and CR/LF.
 */
function escapePropertyValue(value: string): string {
  return value
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A')
    .replace(/:/g, '%3A')
    .replace(/,/g, '%2C');
}

/**
 * Escapes the workflow command data (the part after `::`).
 * Only percent, CR, and LF need escaping in the data portion.
 */
function escapeData(value: string): string {
  return value
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A');
}

/**
 * Formats analysis results as GitHub Actions workflow commands.
 *
 * When dangerousLockTitle is true (e.g. via --github-actions):
 *   ::error file={filePath},line={line},title=Dangerous Lock ({ruleId})::{message}
 *
 * When dangerousLockTitle is false (legacy default):
 *   ::error file={filePath},line={line},col={column},title=ddlforge::{message}
 */
export function formatGithub(
  results: AnalysisResult[],
  options: GithubReporterOptions = {}
): string {
  const { emitAdvisories = false, dangerousLockTitle = false } = options;
  const isGithubActions = dangerousLockTitle || process.env.GITHUB_ACTIONS === 'true';
  const shouldSuggestFix = options.suggestFix ?? isGithubActions;
  const lines: string[] = [];

  for (const res of results) {
    for (const finding of res.findings) {
      if (finding.suppressed) continue;

      const rawFile = finding.file ?? res.file;
      const fileProp = escapePropertyValue(rawFile);
      const lineProp = String(finding.line ?? 1);
      const colProp  = String(finding.column ?? 1);

      let messageText = finding.message;
      if (shouldSuggestFix && finding.remediation && finding.remediation.trim().length > 0) {
        messageText += `\n\n💡 Recommended Safe Fix:\n\`\`\`sql\n${finding.remediation.trim()}\n\`\`\``;
      }
      const msg      = escapeData(messageText);

      let props: string;
      if (dangerousLockTitle) {
        const titleProp = escapePropertyValue(`Dangerous Lock (${finding.ruleId})`);
        props = `file=${fileProp},line=${lineProp},title=${titleProp}`;
      } else {
        const titleProp = 'ddlforge';
        props = `file=${fileProp},line=${lineProp},col=${colProp},title=${titleProp}`;
      }

      if (finding.severity === 'BLOCKER') {
        lines.push(`::error ${props}::${msg}`);
      } else if (finding.severity === 'WARNING') {
        lines.push(`::warning ${props}::${msg}`);
      } else if (finding.severity === 'ADVISORY' && emitAdvisories) {
        lines.push(`::notice ${props}::${msg}`);
      }
    }
  }

  return lines.join('\n');
}

/**
 * Derives a human-readable downtime risk description from lock level and severity.
 */
function getDowntimeRisk(finding: Finding): string {
  if (finding.lockLevel === PostgresLockLevel.ACCESS_EXCLUSIVE) {
    return 'Critical / High (Full Table Lock - Blocks Reads & Writes)';
  }
  if (finding.lockLevel === PostgresLockLevel.EXCLUSIVE) {
    return 'High (Blocks Reads & Writes)';
  }
  if (finding.lockLevel === PostgresLockLevel.SHARE || finding.lockLevel === PostgresLockLevel.SHARE_ROW_EXCLUSIVE) {
    return 'High (Blocks Concurrent Writes)';
  }
  if (finding.lockLevel === PostgresLockLevel.SHARE_UPDATE_EXCLUSIVE) {
    return 'Low (Concurrent Safe)';
  }
  if (finding.severity === 'BLOCKER') {
    return 'High (Migration Blocker)';
  }
  if (finding.severity === 'WARNING') {
    return 'Medium';
  }
  return 'Low';
}

/**
 * Generates a clean Markdown summary table showing:
 *   File, Line, Statement, Lock Type, Downtime Risk, and Recommended Fix.
 * Appends a 💡 Recommended Safe Fix codeblock section when fixes are available.
 */
export function generateStepSummary(
  results: AnalysisResult[],
  options: StepSummaryOptions = {}
): string {
  const rows: string[] = [];
  rows.push('### ddlforge Migration Safety Summary\n');
  rows.push('| File | Line | Statement | Lock Type | Downtime Risk | Recommended Fix |');
  rows.push('| --- | --- | --- | --- | --- | --- |');

  let totalFindings = 0;
  const findingsWithFix: Array<{ file: string; line: string; ruleId: string; remediation: string }> = [];

  for (const res of results) {
    for (const finding of res.findings) {
      if (finding.suppressed) continue;
      totalFindings++;

      const file = (finding.file ?? res.file).replace(/\\/g, '/');
      const line = String(finding.line ?? 1);
      const rawStmt = (finding.codeSnippet || finding.message)
        .replace(/\r?\n/g, ' ')
        .replace(/\|/g, '\\|')
        .trim();
      const statement = `\`${rawStmt.length > 60 ? rawStmt.slice(0, 57) + '...' : rawStmt}\``;
      const lockType = finding.lockLevel ?? 'NONE';
      const downtimeRisk = getDowntimeRisk(finding);
      const recFix = (finding.suggestion || finding.detail || 'None')
        .replace(/\r?\n/g, ' ')
        .replace(/\|/g, '\\|')
        .trim();

      rows.push(`| ${file} | ${line} | ${statement} | ${lockType} | ${downtimeRisk} | ${recFix} |`);

      if (finding.remediation && finding.remediation.trim().length > 0) {
        findingsWithFix.push({
          file,
          line,
          ruleId: finding.ruleId,
          remediation: finding.remediation.trim(),
        });
      }
    }
  }

  if (totalFindings === 0) {
    return '### ddlforge Migration Safety Summary\n\n✅ All migration statements passed safety checks. Zero dangerous locks detected.\n';
  }

  let summaryMarkdown = rows.join('\n') + '\n';

  const isGithubActions = process.env.GITHUB_ACTIONS === 'true';
  const shouldSuggestFix = options.suggestFix !== false && (
    options.suggestFix === true ||
    isGithubActions ||
    findingsWithFix.length > 0
  );

  if (shouldSuggestFix && findingsWithFix.length > 0) {
    summaryMarkdown += '\n### 💡 Recommended Safe Fix\n\n';
    for (const item of findingsWithFix) {
      summaryMarkdown += `#### \`${item.file}:${item.line}\` (${item.ruleId})\n\n`;
      summaryMarkdown += '```sql\n';
      summaryMarkdown += item.remediation + '\n';
      summaryMarkdown += '```\n\n';
    }
  }

  return summaryMarkdown;
}

/**
 * Appends the clean summary table to GITHUB_STEP_SUMMARY if the environment variable is present.
 */
export function writeStepSummary(
  summaryPath: string,
  results: AnalysisResult[],
  options?: StepSummaryOptions
): void {
  const markdown = generateStepSummary(results, options);
  fs.appendFileSync(summaryPath, markdown, 'utf-8');
}

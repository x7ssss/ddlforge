/**
 * ddlforge - GitHub Actions Workflow Commands reporter
 *
 * Formats diagnostics as GitHub Actions annotation commands:
 *   ::error file={f},line={l},col={c},title=ddlforge::{message}
 *   ::warning file={f},line={l},col={c},title=ddlforge::{message}
 *
 * Reference: https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/workflow-commands-for-github-actions
 */

import { AnalysisResult } from '../engine/analyzer.js';

export interface GithubReporterOptions {
  /** If true, also emit a ::notice for advisory findings (default: false) */
  emitAdvisories?: boolean;
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
 * Each BLOCKER finding produces an `::error ...` annotation.
 * Each WARNING finding produces a `::warning ...` annotation.
 * ADVISORY findings produce `::notice ...` annotations only when
 * `options.emitAdvisories` is true.
 *
 * Returns a newline-joined string ready for direct `process.stdout.write`.
 */
export function formatGithub(
  results: AnalysisResult[],
  options: GithubReporterOptions = {}
): string {
  const { emitAdvisories = false } = options;
  const lines: string[] = [];

  for (const res of results) {
    for (const finding of res.findings) {
      const fileProp = escapePropertyValue(finding.file ?? res.file);
      const lineProp = String(finding.line ?? 1);
      const colProp  = String(finding.column ?? 1);
      const title    = 'ddlforge';
      const msg      = escapeData(finding.message);

      const props = `file=${fileProp},line=${lineProp},col=${colProp},title=${title}`;

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

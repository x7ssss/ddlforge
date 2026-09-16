/**
 * ddlforge - Clean, colorized TTY terminal reporter with code spans
 */

import { Finding, Severity } from '../rules/types.js';
import { AnalysisResult } from '../engine/analyzer.js';

export interface TerminalReporterOptions {
  quiet?: boolean;
  color?: boolean;
}

const supportsColor = (override?: boolean): boolean => {
  if (override !== undefined) return override;
  if (process.env.NO_COLOR || process.env.NODE_DISABLE_COLORS) return false;
  if (process.env.FORCE_COLOR) return true;
  return process.stdout.isTTY ?? false;
};

export function formatTerminal(results: AnalysisResult[], options: TerminalReporterOptions = {}): string {
  const useColor = supportsColor(options.color);
  const quiet = options.quiet ?? false;

  const c = {
    reset: useColor ? '\x1b[0m' : '',
    bold: useColor ? '\x1b[1m' : '',
    dim: useColor ? '\x1b[2m' : '',
    red: useColor ? '\x1b[31m' : '',
    green: useColor ? '\x1b[32m' : '',
    yellow: useColor ? '\x1b[33m' : '',
    blue: useColor ? '\x1b[34m' : '',
    magenta: useColor ? '\x1b[35m' : '',
    cyan: useColor ? '\x1b[36m' : '',
    gray: useColor ? '\x1b[90m' : '',
    bgRed: useColor ? '\x1b[41m\x1b[37m' : '',
    bgYellow: useColor ? '\x1b[43m\x1b[30m' : '',
  };

  const lines: string[] = [];

  let totalBlockers = 0;
  let totalWarnings = 0;
  let totalAdvisories = 0;
  let totalStatements = 0;
  let totalDuration = 0;
  let totalFilesScanned = results.length;

  for (const res of results) {
    totalBlockers += res.blockersCount;
    totalWarnings += res.warningsCount;
    totalAdvisories += res.advisoriesCount;
    totalStatements += res.statementsAnalyzed;
    totalDuration += res.durationMs;

    const visibleFindings = quiet
      ? res.findings.filter(f => f.severity === 'BLOCKER')
      : res.findings;

    if (visibleFindings.length === 0) continue;

    lines.push('');
    lines.push(`${c.bold}${c.cyan}📁 ${res.file}${c.reset} ${c.gray}(${res.statementsAnalyzed} statements)${c.reset}`);
    lines.push(c.gray + '─'.repeat(70) + c.reset);

    for (const finding of visibleFindings) {
      const severityBadge = formatSeverityBadge(finding.severity, c);
      const lockBadge = finding.lockLevel !== 'NONE'
        ? ` ${c.magenta}[LOCK: ${finding.lockLevel}]${c.reset}`
        : '';

      lines.push(`${severityBadge} ${c.bold}${finding.message}${c.reset}${lockBadge}`);
      lines.push(`   ${c.gray}at ${res.file}:${finding.line}:${finding.column}${c.reset} ${c.dim}(rule: ${finding.ruleId})${c.reset}`);

      if (finding.codeSnippet) {
        lines.push('');
        const snippetLines = finding.codeSnippet.split('\n');
        snippetLines.forEach((snipLine, i) => {
          const lineNum = String(finding.line + i).padStart(4, ' ');
          lines.push(`   ${c.dim}${lineNum} │${c.reset} ${c.yellow}${snipLine}${c.reset}`);
        });
      }

      if (finding.detail) {
        lines.push(`   ${c.dim}Why:${c.reset} ${finding.detail}`);
      }

      if (finding.suggestion) {
        lines.push(`   ${c.green}${c.bold}Fix:${c.reset}`);
        const suggestionLines = finding.suggestion.split('\n');
        for (const sLine of suggestionLines) {
          lines.push(`      ${c.green}${sLine}${c.reset}`);
        }
      }

      lines.push('');
    }
  }

  // Summary footer
  lines.push('');
  lines.push(c.gray + '━'.repeat(70) + c.reset);

  const durationStr = `${totalDuration.toFixed(1)}ms`;

  if (totalBlockers > 0) {
    lines.push(
      `${c.red}${c.bold}✖ FAILED:${c.reset} Found ${c.bold}${c.red}${totalBlockers} blocker(s)${c.reset}` +
      (totalWarnings > 0 ? `, ${c.yellow}${totalWarnings} warning(s)${c.reset}` : '') +
      ` across ${totalFilesScanned} file(s) [${durationStr}]`
    );
    lines.push(`${c.dim}Run with --quiet to display blockers only.${c.reset}`);
  } else if (totalWarnings > 0) {
    lines.push(
      `${c.yellow}${c.bold}⚠ PASSED WITH ADVISORIES:${c.reset} 0 blockers, ${c.yellow}${totalWarnings} warning(s)${c.reset}` +
      ` across ${totalFilesScanned} file(s) [${durationStr}]`
    );
  } else {
    lines.push(
      `${c.green}${c.bold}✔ ALL CLEAR:${c.reset} Checked ${totalFilesScanned} migration file(s) ` +
      `(${totalStatements} statements) with zero lock or data-loss violations [${durationStr}]`
    );
  }

  return lines.join('\n');
}

function formatSeverityBadge(severity: Severity, c: Record<string, string>): string {
  switch (severity) {
    case 'BLOCKER':
      return `${c.bgRed} BLOCKER ${c.reset}`;
    case 'WARNING':
      return `${c.bgYellow} WARNING ${c.reset}`;
    case 'ADVISORY':
      return `${c.cyan}[ADVISORY]${c.reset}`;
  }
}

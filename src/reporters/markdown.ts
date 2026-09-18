/**
 * ddlforge - CI PR Comment / Markdown Report Formatter
 */

import { AnalysisResult } from '../engine/analyzer.js';

export function formatMarkdown(results: AnalysisResult[]): string {
  let filesScanned = results.length;
  let statementsAnalyzed = 0;
  let blockers = 0;
  let warnings = 0;
  let advisories = 0;
  let durationMs = 0;

  for (const res of results) {
    statementsAnalyzed += res.statementsAnalyzed;
    blockers += res.blockersCount;
    warnings += res.warningsCount;
    advisories += res.advisoriesCount;
    durationMs += res.durationMs;
  }

  const lines: string[] = [];

  lines.push('## 🛡️ ddlforge Migration Lock & Safety Report');
  lines.push('');

  const statusEmoji = blockers > 0 ? '❌ **FAILED**' : warnings > 0 ? '⚠️ **PASSED WITH WARNINGS**' : '✅ **PASSED**';
  lines.push(`**Status:** ${statusEmoji} (${durationMs.toFixed(1)}ms)`);
  lines.push('');

  // Summary Table
  lines.push('| Metric | Count |');
  lines.push('|:---|:---|');
  lines.push(`| 🛑 **Blocking Violations** | \`${blockers}\` |`);
  lines.push(`| ⚠️ **Warnings / Advisories** | \`${warnings + advisories}\` |`);
  lines.push(`| 📄 **Files Scanned** | \`${filesScanned}\` |`);
  lines.push(`| ⚡ **Statements Analyzed** | \`${statementsAnalyzed}\` |`);
  lines.push('');

  if (blockers === 0 && warnings === 0 && advisories === 0) {
    lines.push('> ✨ **All migrations are safe!** No dangerous table locks or destructive data loss patterns detected.');
    return lines.join('\n');
  }

  lines.push('### Detailed Findings');
  lines.push('');

  for (const res of results) {
    if (res.findings.length === 0) continue;

    lines.push(`#### 📁 \`${res.file}\``);
    lines.push('');

    for (const finding of res.findings) {
      const badge = finding.severity === 'BLOCKER' ? '🛑 `BLOCKER`' : '⚠️ `WARNING`';
      const lock = finding.lockLevel !== 'NONE' ? ` · Lock: \`${finding.lockLevel}\`` : '';

      lines.push(`<details ${finding.severity === 'BLOCKER' ? 'open' : ''}>`);
      lines.push(`<summary>${badge} <b>${finding.message}</b> (Line ${finding.line})${lock}</summary>`);
      lines.push('');
      lines.push(`- **Rule:** \`${finding.ruleId}\``);
      lines.push(`- **Location:** \`${res.file}:${finding.line}:${finding.column}\``);
      lines.push(`- **Impact:** ${finding.detail}`);
      lines.push('');
      lines.push('```sql');
      lines.push(finding.codeSnippet);
      lines.push('```');
      lines.push('');
      lines.push('**Suggested Zero-Downtime Fix:**');
      lines.push('```sql');
      lines.push(finding.suggestion);
      lines.push('```');
      lines.push('');
      if (finding.remediation) {
        lines.push('**Zero-Downtime Remediation Recipe:**');
        lines.push('```sql');
        lines.push(finding.remediation);
        lines.push('```');
        lines.push('');
      }
      lines.push('</details>');
      lines.push('');
    }
  }

  lines.push('---');
  lines.push('*Automated by [ddlforge](https://github.com/x7ssss/ddlforge) — Zero-runtime-dependency Postgres Lock Linter*');

  return lines.join('\n');
}

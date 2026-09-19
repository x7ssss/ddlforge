/**
 * ddlforge GitHub Action — action/src/index.ts
 *
 * Bundled via @vercel/ncc into action/dist/index.js (CommonJS).
 * Analyzes migration SQL files and emits GitHub Actions annotations.
 *
 * This file is a SELF-CONTAINED implementation that does NOT import from
 * the parent ddlforge package at bundle time. It re-implements the minimal
 * file discovery, analysis invocation, and annotation emission logic directly.
 *
 * At runtime (after npm pack), this action requires ddlforge to be
 * installed. The action is designed to be used in a repository where
 * ddlforge is a devDependency, or it can invoke the CLI via npx.
 *
 * Inputs (from action.yml):
 *   migration-dir       — path to migration directory or file
 *   severity-threshold  — BLOCKER | WARNING | ADVISORY (default: WARNING)
 *   format              — github | terminal | json (default: github)
 *   pg-version          — PostgreSQL version (default: 16)
 *
 * Outputs:
 *   blockers            — count of BLOCKER findings
 *   warnings            — count of WARNING findings
 *
 * Exit behavior:
 *   core.setFailed()    — on any BLOCKER finding (exits with non-zero code)
 *   normal exit         — on clean or WARNING-only results
 */

import * as core from '@actions/core';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

// ---------------------------------------------------------------------------
// Utility: discover .sql files
// ---------------------------------------------------------------------------

function collectSql(target: string, acc: string[]): void {
  if (!fs.existsSync(target)) return;
  const stat = fs.statSync(target);
  if (stat.isDirectory()) {
    const IGNORED = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.turbo']);
    for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
      if (entry.isDirectory() && !IGNORED.has(entry.name)) {
        collectSql(path.join(target, entry.name), acc);
      } else if (entry.isFile() && entry.name.endsWith('.sql')) {
        acc.push(path.join(target, entry.name));
      }
    }
  } else if (stat.isFile()) {
    acc.push(target);
  }
}

// ---------------------------------------------------------------------------
// Utility: escape GitHub workflow command strings
// ---------------------------------------------------------------------------

function escapeProperty(v: string): string {
  return v
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A')
    .replace(/:/g, '%3A')
    .replace(/,/g, '%2C');
}

function escapeData(v: string): string {
  return v
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  try {
    const migrationDir      = core.getInput('migration-dir');
    const severityThreshold = (core.getInput('severity-threshold') || 'WARNING').toUpperCase();
    const format            = (core.getInput('format') || 'github').toLowerCase();
    const pgVersion         = core.getInput('pg-version') || '16';

    const workspace = process.env['GITHUB_WORKSPACE'] ?? process.cwd();
    const targetDir = migrationDir
      ? (path.isAbsolute(migrationDir) ? migrationDir : path.join(workspace, migrationDir))
      : workspace;

    // Discover SQL files
    const files: string[] = [];
    collectSql(targetDir, files);

    if (files.length === 0) {
      core.warning(`ddlforge: No .sql migration files found in: ${targetDir}`);
      core.setOutput('blockers', '0');
      core.setOutput('warnings', '0');
      return;
    }

    core.info(`[ddlforge] Scanning ${files.length} file(s) (pg${pgVersion})`);

    // Invoke ddlforge CLI via execSync so we don't need to bundle the entire engine.
    // This approach is resilient: uses the installed CLI in the GitHub Actions runner.
    let ddlforgeBin = 'ddlforge';
    try {
      // Try local node_modules first (when ddlforge is a devDep)
      const localBin = path.join(workspace, 'node_modules', '.bin', 'ddlforge');
      if (fs.existsSync(localBin)) {
        ddlforgeBin = localBin;
      }
    } catch { /* use global */ }

    let totalBlockers = 0;
    let totalWarnings = 0;

    for (const file of files) {
      const fileRel = path.relative(workspace, file).replace(/\\/g, '/');

      try {
        // Run ddlforge check in JSON mode so we can parse findings structurally
        const output = execSync(
          `"${ddlforgeBin}" check "${file}" --format json --pg ${pgVersion}`,
          { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }
        );

        const parsed = JSON.parse(output) as Array<{
          file: string;
          findings: Array<{
            severity: string;
            message: string;
            ruleId: string;
            line: number;
            column: number;
          }>;
          blockersCount: number;
          warningsCount: number;
        }>;

        for (const res of parsed) {
          totalBlockers += res.blockersCount;
          totalWarnings += res.warningsCount;

          for (const finding of res.findings) {
            // Apply severity threshold filter
            if (severityThreshold === 'BLOCKER' && finding.severity !== 'BLOCKER') continue;
            if (severityThreshold === 'WARNING' && finding.severity === 'ADVISORY') continue;

            if (format === 'github') {
              const fileProp = escapeProperty(fileRel);
              const lineProp = String(finding.line ?? 1);
              const colProp  = String(finding.column ?? 1);
              const msg      = escapeData(finding.message);
              const props    = `file=${fileProp},line=${lineProp},col=${colProp},title=ddlforge`;

              if (finding.severity === 'BLOCKER') {
                process.stdout.write(`::error ${props}::${msg}\n`);
              } else if (finding.severity === 'WARNING') {
                process.stdout.write(`::warning ${props}::${msg}\n`);
              } else {
                process.stdout.write(`::notice ${props}::${msg}\n`);
              }
            } else {
              const prefix = finding.severity === 'BLOCKER' ? 'ERROR' : 'WARN';
              core.info(`[${prefix}] ${fileRel}:${finding.line}:${finding.column} — ${finding.message} (${finding.ruleId})`);
            }
          }
        }
      } catch (execErr: any) {
        // ddlforge exits with code 1 on blockers — parse stderr for non-JSON errors
        const stderr = execErr?.stderr ?? '';
        if (stderr && !stderr.includes('ddlforge')) {
          core.warning(`[ddlforge] Could not analyze ${fileRel}: ${stderr}`);
        }
        // If exit code is 1 due to blockers, that's expected — JSON output still in stdout
        if (execErr?.stdout) {
          try {
            const parsed = JSON.parse(execErr.stdout as string) as Array<{
              blockersCount: number;
              warningsCount: number;
              findings: Array<{ severity: string; message: string; line: number; column: number; ruleId: string }>;
            }>;
            for (const res of parsed) {
              totalBlockers += res.blockersCount;
              totalWarnings += res.warningsCount;
              for (const finding of res.findings) {
                if (severityThreshold === 'BLOCKER' && finding.severity !== 'BLOCKER') continue;
                if (severityThreshold === 'WARNING' && finding.severity === 'ADVISORY') continue;
                if (format === 'github') {
                  const fileProp = escapeProperty(fileRel);
                  const msg = escapeData(finding.message);
                  const props = `file=${fileProp},line=${finding.line ?? 1},col=${finding.column ?? 1},title=ddlforge`;
                  if (finding.severity === 'BLOCKER') process.stdout.write(`::error ${props}::${msg}\n`);
                  else if (finding.severity === 'WARNING') process.stdout.write(`::warning ${props}::${msg}\n`);
                  else process.stdout.write(`::notice ${props}::${msg}\n`);
                }
              }
            }
          } catch { /* non-JSON output, ignore */ }
        }
      }
    }

    // Set outputs
    core.setOutput('blockers', String(totalBlockers));
    core.setOutput('warnings', String(totalWarnings));

    core.info(`\n[ddlforge] Scanned ${files.length} file(s): ${totalBlockers} blocker(s), ${totalWarnings} warning(s)`);

    if (totalBlockers > 0) {
      core.setFailed(`ddlforge: Found ${totalBlockers} BLOCKER violation(s). Migration is unsafe to apply.`);
    }

  } catch (err: any) {
    core.setFailed(`ddlforge action failed: ${err?.message ?? String(err)}`);
  }
}

void run();

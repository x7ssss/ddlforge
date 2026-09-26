/**
 * ddlforge - SARIF 2.1.0 reporter for GitHub Code Scanning / Actions annotations.
 *
 * Spec: https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html
 */

import { AnalysisResult } from '../engine/analyzer.js';
import { Rule } from '../rules/types.js';
import { ALL_RULES } from '../rules/index.js';

const SARIF_SCHEMA = 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json';
const SARIF_VERSION = '2.1.0';
const TOOL_NAME = 'ddlforge';
const TOOL_VERSION = '0.6.0';
const TOOL_INFO_URI = 'https://github.com/ddlforge/ddlforge';

// ── SARIF 2.1.0 type definitions (inline — no external dependency) ─────────

export interface SarifLog {
  $schema: string;
  version: string;
  runs: SarifRun[];
}

export interface SarifRun {
  tool: SarifTool;
  results: SarifResult[];
  artifacts: SarifArtifact[];
}

export interface SarifTool {
  driver: SarifDriver;
}

export interface SarifDriver {
  name: string;
  version: string;
  informationUri: string;
  rules: SarifReportingDescriptor[];
}

export interface SarifReportingDescriptor {
  id: string;
  shortDescription: SarifMessage;
  fullDescription: SarifMessage;
  defaultConfiguration: {
    level: 'error' | 'warning' | 'note';
  };
  helpUri: string;
}

export interface SarifSuppression {
  kind: 'inSource' | 'external' | string;
  justification?: string;
}

export interface SarifResult {
  ruleId: string;
  level: 'error' | 'warning' | 'note';
  message: SarifMessage;
  locations: SarifLocation[];
  suppressions?: SarifSuppression[];
}

export interface SarifMessage {
  text: string;
}

export interface SarifLocation {
  physicalLocation: SarifPhysicalLocation;
}

export interface SarifPhysicalLocation {
  artifactLocation: SarifArtifactLocation;
  region: SarifRegion;
}

export interface SarifArtifactLocation {
  uri: string;
  uriBaseId: string;
}

export interface SarifRegion {
  startLine: number;
  startColumn: number;
}

export interface SarifArtifact {
  location: SarifArtifactLocation;
}

// ── Helpers ────────────────────────────────────────────────────────────────

type SarifLevel = 'error' | 'warning' | 'note';

function severityToLevel(severity: string): SarifLevel {
  switch (severity) {
    case 'BLOCKER':  return 'error';
    case 'WARNING':  return 'warning';
    case 'ADVISORY': return 'note';
    default:         return 'warning';
  }
}

function fileToUri(filePath: string): string {
  // Convert Windows backslashes to forward slashes for file:// URIs
  return 'file:///' + filePath.replace(/\\/g, '/');
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Formats an array of AnalysisResult objects as a SARIF 2.1.0 JSON string,
 * suitable for consumption by GitHub Code Scanning or other SARIF-aware tools.
 *
 * @param results - Analysis results from the ddlforge engine.
 * @param rules   - Rule definitions used to populate `tool.driver.rules`.
 *                  Defaults to ALL_RULES.
 */
export function formatSarif(results: AnalysisResult[], rules: Rule[] = ALL_RULES): string {
  // Build tool.driver.rules from the provided rule set
  const sarifRules: SarifReportingDescriptor[] = rules.map((rule) => ({
    id: rule.id,
    shortDescription: { text: rule.name },
    fullDescription: { text: rule.description },
    defaultConfiguration: {
      level: severityToLevel(rule.defaultSeverity),
    },
    helpUri: `${TOOL_INFO_URI}#${rule.id}`,
  }));

  // Collect all findings (both active and suppressed) across all results
  const sarifResults: SarifResult[] = [];
  const uniqueFiles = new Set<string>();
  const ruleIdSet = new Set(sarifRules.map((r) => r.id));

  for (const analysisResult of results) {
    const allFindings = [
      ...analysisResult.findings,
      ...(analysisResult.suppressedFindings ?? []),
    ];

    for (const finding of allFindings) {
      uniqueFiles.add(finding.file);

      // Dynamically add descriptors for synthetic rules (e.g. INVALID_WAIVER, EXPIRED_WAIVER)
      if (!ruleIdSet.has(finding.ruleId)) {
        ruleIdSet.add(finding.ruleId);
        sarifRules.push({
          id: finding.ruleId,
          shortDescription: { text: finding.ruleName || finding.ruleId },
          fullDescription: { text: finding.detail || finding.message || finding.ruleId },
          defaultConfiguration: {
            level: severityToLevel(finding.severity),
          },
          helpUri: `${TOOL_INFO_URI}#${finding.ruleId}`,
        });
      }

      const messageParts: string[] = [finding.message];
      if (finding.detail) messageParts.push(finding.detail);
      if (finding.suggestion) messageParts.push(`Fix: ${finding.suggestion}`);

      const sarifItem: SarifResult = {
        ruleId: finding.ruleId,
        level: severityToLevel(finding.severity),
        message: { text: messageParts.join('. ') },
        locations: [
          {
            physicalLocation: {
              artifactLocation: {
                uri: fileToUri(finding.file),
                uriBaseId: '%SRCROOT%',
              },
              region: {
                startLine: finding.line,
                startColumn: finding.column,
              },
            },
          },
        ],
      };

      if (finding.suppressed || (finding.suppressions && finding.suppressions.length > 0)) {
        sarifItem.suppressions = [{ kind: 'inSource' }];
      }

      sarifResults.push(sarifItem);
    }
  }

  // Build artifacts list from unique file paths
  const artifacts: SarifArtifact[] = Array.from(uniqueFiles).map((file) => ({
    location: {
      uri: fileToUri(file),
      uriBaseId: '%SRCROOT%',
    },
  }));

  const log: SarifLog = {
    $schema: SARIF_SCHEMA,
    version: SARIF_VERSION,
    runs: [
      {
        tool: {
          driver: {
            name: TOOL_NAME,
            version: TOOL_VERSION,
            informationUri: TOOL_INFO_URI,
            rules: sarifRules,
          },
        },
        results: sarifResults,
        artifacts,
      },
    ],
  };

  return JSON.stringify(log, null, 2);
}

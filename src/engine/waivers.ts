/**
 * ddlforge - Statement-level inline SQL waiver parser and validator
 *
 * Syntax:
 *   -- ddlforge-disable-next-line <rule-id> reason="<mandatory-reason>" [expires="YYYY-MM-DD"]
 */

import { Finding } from '../rules/types.js';
import { Statement, Token } from '../lexer/tokens.js';
import { PostgresLockLevel } from './locks.js';

export interface InlineWaiver {
  ruleId: string;
  reason?: string;
  expires?: string;
  line: number;
  column: number;
  rawComment: string;
  isValid: boolean;
  errorFinding?: Finding;
}

export interface WaiverOptions {
  filePath?: string;
  currentDate?: Date;
}

export interface WaiverProcessingResult {
  activeFindings: Finding[];
  suppressedFindings: Finding[];
  waiverErrors: Finding[];
}

const WAIVER_DIRECTIVE = 'ddlforge-disable-next-line';

/**
 * Checks if a comment contains a ddlforge-disable-next-line directive.
 */
export function isWaiverComment(commentText: string): boolean {
  return commentText.toLowerCase().includes(WAIVER_DIRECTIVE);
}

/**
 * Parses waiver directives from tokens or comments preceding a statement.
 */
export function parseStatementWaivers(
  stmt: Statement,
  options: WaiverOptions = {}
): InlineWaiver[] {
  const waivers: InlineWaiver[] = [];
  const filePath = options.filePath ?? 'anonymous.sql';
  const now = options.currentDate ?? new Date();

  // YYYY-MM-DD string for date comparison
  const todayStr = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');

  // Use commentTokens if available, otherwise fall back to string comments
  const commentTokens: Array<{ raw: string; line: number; column: number }> =
    stmt.commentTokens && stmt.commentTokens.length > 0
      ? stmt.commentTokens
      : stmt.comments.map(c => ({ raw: c, line: stmt.startLine > 1 ? stmt.startLine - 1 : 1, column: 1 }));

  for (const cTok of commentTokens) {
    const raw = cTok.raw;
    if (!isWaiverComment(raw)) continue;

    // A single comment may contain multiple lines if it's a block comment or multiline string
    const lines = raw.split(/\r?\n/);
    lines.forEach((lineText, lineIdx) => {
      const lineNum = cTok.line + lineIdx;
      if (!isWaiverComment(lineText)) return;

      // Match: -- ddlforge-disable-next-line <rule-id> <attributes...>
      // or /* ddlforge-disable-next-line <rule-id> <attributes...> */
      const match = lineText.match(/(?:--|\/\*)\s*ddlforge-disable-next-line(?:\s+([a-zA-Z0-9_*\\-]+))?(.*)$/i);
      if (!match) return;

      const rawRuleId = match[1]?.trim() || '*';
      let rest = match[2] || '';
      // Strip trailing block comment close */
      rest = rest.replace(/\*\/.*$/, '');

      // Parse reason="..." or reason='...' or reason=\S+
      const reasonMatch = rest.match(/\breason=(?:"([^"]*)"|'([^']*)'|(\S+))/i);
      const reason = reasonMatch
        ? (reasonMatch[1] ?? reasonMatch[2] ?? reasonMatch[3] ?? '')
        : undefined;

      // Parse expires="YYYY-MM-DD" or expires='YYYY-MM-DD'
      const expiresMatch = rest.match(/\bexpires=(?:"([^"]*)"|'([^']*)'|(\S+))/i);
      const expires = expiresMatch
        ? (expiresMatch[1] ?? expiresMatch[2] ?? expiresMatch[3] ?? '')
        : undefined;

      // 1. Validation check: reason is mandatory and must be >= 8 characters
      if (reason === undefined || reason.trim().length === 0) {
        const errorFinding: Finding = {
          ruleId: 'INVALID_WAIVER',
          ruleName: 'Invalid Inline Waiver',
          severity: 'BLOCKER',
          lockLevel: PostgresLockLevel.NONE,
          message: `Inline waiver rejected: missing mandatory reason attribute for rule "${rawRuleId}"`,
          detail: `The waiver directly preceding line ${stmt.startLine} is missing a mandatory reason string. Reason must be at least 8 characters.`,
          suggestion: `Add reason="<explanation of at least 8 characters>" to the waiver directive.`,
          file: filePath,
          line: lineNum,
          column: cTok.column,
          codeSnippet: lineText.trim(),
        };
        waivers.push({
          ruleId: rawRuleId,
          reason,
          expires,
          line: lineNum,
          column: cTok.column,
          rawComment: lineText.trim(),
          isValid: false,
          errorFinding,
        });
        return;
      }

      if (reason.trim().length < 8) {
        const errorFinding: Finding = {
          ruleId: 'INVALID_WAIVER',
          ruleName: 'Invalid Inline Waiver',
          severity: 'BLOCKER',
          lockLevel: PostgresLockLevel.NONE,
          message: `Inline waiver rejected: reason is shorter than 8 characters ("${reason}")`,
          detail: `The waiver reason "${reason}" is only ${reason.trim().length} character(s). A minimum of 8 characters is required to document waiver justification.`,
          suggestion: `Provide a descriptive explanation of why this lock risk is accepted: reason="<at least 8 chars>"`,
          file: filePath,
          line: lineNum,
          column: cTok.column,
          codeSnippet: lineText.trim(),
        };
        waivers.push({
          ruleId: rawRuleId,
          reason,
          expires,
          line: lineNum,
          column: cTok.column,
          rawComment: lineText.trim(),
          isValid: false,
          errorFinding,
        });
        return;
      }

      // 2. Expiration check: if expires provided and current date > expires, reject with EXPIRED_WAIVER
      if (expires) {
        const isExpired = todayStr > expires;
        if (isExpired) {
          const errorFinding: Finding = {
            ruleId: 'EXPIRED_WAIVER',
            ruleName: 'Expired Inline Waiver',
            severity: 'BLOCKER',
            lockLevel: PostgresLockLevel.NONE,
            message: `Inline waiver for "${rawRuleId}" expired on ${expires}: ${reason}`,
            detail: `The waiver expiration date (${expires}) has passed (current date: ${todayStr}). Suppression is ignored and the waiver must be renewed or removed.`,
            suggestion: `Renew the waiver expiration date if an exception is still granted, or eliminate the underlying lock conflict.`,
            file: filePath,
            line: lineNum,
            column: cTok.column,
            codeSnippet: lineText.trim(),
          };
          waivers.push({
            ruleId: rawRuleId,
            reason,
            expires,
            line: lineNum,
            column: cTok.column,
            rawComment: lineText.trim(),
            isValid: false,
            errorFinding,
          });
          return;
        }
      }

      // Valid and active waiver
      waivers.push({
        ruleId: rawRuleId,
        reason,
        expires,
        line: lineNum,
        column: cTok.column,
        rawComment: lineText.trim(),
        isValid: true,
      });
    });
  }

  return waivers;
}

/**
 * Checks if a finding matches a waiver's target rule ID, alias, or lock level.
 */
export function ruleMatchesWaiver(waiverRuleId: string, finding: Finding): boolean {
  const target = waiverRuleId.toLowerCase();
  const actual = finding.ruleId.toLowerCase();

  // Wildcard matches everything
  if (target === '*' || target === 'all') {
    return true;
  }

  // Exact rule id match
  if (target === actual) {
    return true;
  }

  // Lock-level waiver matching: e.g. "lock-access-exclusive"
  if (target === 'lock-access-exclusive' || target === 'access-exclusive') {
    return finding.lockLevel === PostgresLockLevel.ACCESS_EXCLUSIVE;
  }

  // Known rule aliases
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
    'concurrent-in-transaction': ['concurrent-index-in-transaction'],
    'concurrent-index-in-transaction': ['concurrent-in-transaction'],
    'partition-scan-lock': ['attach-partition-missing-check'],
    'attach-partition-missing-check': ['partition-scan-lock'],
  };

  const aliases = aliasMap[target];
  if (aliases && aliases.map(a => a.toLowerCase()).includes(actual)) {
    return true;
  }

  return false;
}

/**
 * Checks if a finding belongs to a given statement based on line/column coordinates.
 */
export function findingBelongsToStatement(finding: Finding, stmt: Statement): boolean {
  if (finding.line < stmt.startLine || finding.line > stmt.endLine) {
    return false;
  }
  if (finding.line === stmt.startLine && stmt.startLine === stmt.endLine) {
    return finding.column >= stmt.startColumn && finding.column <= stmt.endColumn;
  }
  return true;
}

/**
 * Processes statement-level waivers against all statements and findings.
 * Ensures waivers apply strictly to the immediate next SQL statement without bleeding.
 */
export function processWaivers(
  statements: Statement[],
  rawFindings: Finding[],
  options: WaiverOptions = {}
): WaiverProcessingResult {
  const activeFindings: Finding[] = [];
  const suppressedFindings: Finding[] = [];
  const waiverErrors: Finding[] = [];

  // Map each statement to its findings
  const stmtFindingsMap = new Map<Statement, Finding[]>();
  for (const stmt of statements) {
    stmtFindingsMap.set(stmt, []);
  }

  const unassignedFindings: Finding[] = [];
  for (const finding of rawFindings) {
    let assigned = false;
    for (const stmt of statements) {
      if (findingBelongsToStatement(finding, stmt)) {
        stmtFindingsMap.get(stmt)!.push(finding);
        assigned = true;
        break;
      }
    }
    if (!assigned) {
      unassignedFindings.push(finding);
    }
  }

  // Process statement by statement to guarantee no suppression bleed
  for (const stmt of statements) {
    const waivers = parseStatementWaivers(stmt, options);
    const validWaivers = waivers.filter(w => w.isValid);
    const invalidWaivers = waivers.filter(w => !w.isValid && w.errorFinding);

    for (const iw of invalidWaivers) {
      if (iw.errorFinding) {
        waiverErrors.push(iw.errorFinding);
      }
    }

    const stmtFindings = stmtFindingsMap.get(stmt) ?? [];

    for (const finding of stmtFindings) {
      const matchingWaiver = validWaivers.find(w => ruleMatchesWaiver(w.ruleId, finding));
      if (matchingWaiver) {
        // Suppress finding with SARIF inSource suppression
        const suppressed: Finding = {
          ...finding,
          suppressed: true,
          waiverReason: matchingWaiver.reason,
          suppressions: [{ kind: 'inSource', justification: matchingWaiver.reason }],
        };
        suppressedFindings.push(suppressed);
      } else {
        activeFindings.push(finding);
      }
    }
  }

  // Unassigned findings (e.g. file-level) remain active
  for (const f of unassignedFindings) {
    activeFindings.push(f);
  }

  // Waiver errors are blockers that fail the lint check
  for (const err of waiverErrors) {
    activeFindings.push(err);
  }

  return {
    activeFindings,
    suppressedFindings,
    waiverErrors,
  };
}

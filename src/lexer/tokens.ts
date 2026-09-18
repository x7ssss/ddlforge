/**
 * ddlforge - Token definitions for zero-dependency SQL DDL Lexer
 */

export enum TokenType {
  KEYWORD = 'KEYWORD',
  IDENTIFIER = 'IDENTIFIER',
  STRING = 'STRING',
  DOLLAR_STRING = 'DOLLAR_STRING',
  NUMBER = 'NUMBER',
  OPERATOR = 'OPERATOR',
  PUNCTUATION = 'PUNCTUATION',
  COMMENT = 'COMMENT',
  WHITESPACE = 'WHITESPACE',
  EOF = 'EOF',
}

export interface Token {
  type: TokenType;
  value: string;       // Normalized/unescaped value or upper-case for keywords
  raw: string;         // Exact source text
  line: number;        // 1-based line number
  column: number;      // 1-based column number
  offset: number;      // 0-based character offset
}

export interface Statement {
  raw: string;
  tokens: Token[];
  comments: string[];
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  startOffset: number;
  endOffset: number;
  hasIgnore(ruleId?: string): boolean;
}

// SQL Keywords relevant for DDL & migration safety
export const SQL_KEYWORDS = new Set([
  'ADD',
  'AFTER',
  'ALWAYS',
  'ALTER',
  'ANALYZE',
  'AND',
  'AS',
  'ASC',
  'ATTACH',
  'BEFORE',
  'BEGIN',
  'BETWEEN',
  'BY',
  'CASCADE',
  'CHECK',
  'CLUSTER',
  'COLUMN',
  'COMMIT',
  'CONCURRENTLY',
  'CONSTRAINT',
  'CREATE',
  'DATA',
  'DEFAULT',
  'DELETE',
  'DESC',
  'DETACH',
  'DO',
  'DROP',
  'ELSE',
  'ENUM',
  'END',
  'EXISTS',
  'FINALIZE',
  'FOREIGN',
  'FREEZE',
  'FROM',
  'FULL',
  'GENERATED',
  'IDENTITY',
  'IF',
  'IN',
  'INDEX',
  'INSERT',
  'INTO',
  'IS',
  'JOIN',
  'KEY',
  'LIMIT',
  'NOT',
  'NULL',
  'ON',
  'ONLY',
  'OR',
  'PARTITION',
  'PRIMARY',
  'REINDEX',
  'REFERENCES',
  'RENAME',
  'RESTART',
  'RESTRICT',
  'ROLLBACK',
  'SELECT',
  'SET',
  'START',
  'TABLE',
  'THEN',
  'TO',
  'TRANSACTION',
  'TRUNCATE',
  'TYPE',
  'UNIQUE',
  'UPDATE',
  'USING',
  'VACUUM',
  'VALID',
  'VALIDATE',
  'VALUES',
  'VIEW',
  'WHEN',
  'WHERE',
  'WITH',
]);

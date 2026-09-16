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
  hasIgnore(ruleId?: string): boolean;
}

// SQL Keywords relevant for DDL & migration safety
export const SQL_KEYWORDS = new Set([
  'ADD',
  'ALTER',
  'AND',
  'AS',
  'ASC',
  'BEGIN',
  'BETWEEN',
  'BY',
  'CASCADE',
  'CHECK',
  'COLUMN',
  'COMMIT',
  'CONCURRENTLY',
  'CONSTRAINT',
  'CREATE',
  'DEFAULT',
  'DELETE',
  'DESC',
  'DO',
  'DROP',
  'ELSE',
  'END',
  'EXISTS',
  'FOREIGN',
  'FROM',
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
  'OR',
  'PRIMARY',
  'REFERENCES',
  'RENAME',
  'RESTRICT',
  'ROLLBACK',
  'SELECT',
  'SET',
  'START',
  'TABLE',
  'THEN',
  'TO',
  'TRANSACTION',
  'TYPE',
  'UNIQUE',
  'UPDATE',
  'USING',
  'VALID',
  'VALIDATE',
  'VALUES',
  'VIEW',
  'WHEN',
  'WHERE',
  'WITH',
]);

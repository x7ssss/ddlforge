/**
 * ddlforge - Zero-dependency SQL DDL lexer & statement splitter
 */

import { Token, TokenType, Statement, SQL_KEYWORDS } from './tokens.js';

export interface LexerOptions {
  includeWhitespace?: boolean;
  includeComments?: boolean;
}

export class SqlTokenizer {
  private readonly input: string;
  private readonly length: number;
  private pos: number = 0;
  private line: number = 1;
  private column: number = 1;

  constructor(input: string) {
    if (input.charCodeAt(0) === 0xFEFF) {
      input = input.slice(1);
    }
    this.input = input;
    this.length = input.length;
  }

  public tokenize(options: LexerOptions = {}): Token[] {
    const tokens: Token[] = [];
    this.pos = 0;
    this.line = 1;
    this.column = 1;

    while (this.pos < this.length) {
      const ch = this.input[this.pos];

      // Whitespace
      if (this.isWhitespace(ch)) {
        const token = this.readWhitespace();
        if (options.includeWhitespace) {
          tokens.push(token);
        }
        continue;
      }

      // Single-line comment: -- ...
      if (ch === '-' && this.peek() === '-') {
        const token = this.readSingleLineComment();
        if (options.includeComments ?? true) {
          tokens.push(token);
        }
        continue;
      }

      // Multi-line comment: /* ... */
      if (ch === '/' && this.peek() === '*') {
        const token = this.readMultiLineComment();
        if (options.includeComments ?? true) {
          tokens.push(token);
        }
        continue;
      }

      // Dollar-quoted string: $$ ... $$ or $tag$ ... $tag$
      if (ch === '$' && this.isDollarQuoteStart()) {
        tokens.push(this.readDollarString());
        continue;
      }

      // Standard single-quoted string: ' ... ' (with '' escape)
      if (ch === '\'') {
        tokens.push(this.readSingleQuotedString());
        continue;
      }

      // Quoted identifier: " ... " (with "" escape)
      if (ch === '"') {
        tokens.push(this.readQuotedIdentifier());
        continue;
      }

      // Numbers
      if (this.isDigit(ch)) {
        tokens.push(this.readNumber());
        continue;
      }

      // Multi-character operators and punctuation
      if (ch === ':' && this.peek() === ':') {
        tokens.push(this.createToken(TokenType.OPERATOR, '::', '::', 2));
        continue;
      }

      if (ch === '!' && this.peek() === '=') {
        tokens.push(this.createToken(TokenType.OPERATOR, '!=', '!=', 2));
        continue;
      }

      if (ch === '<' && (this.peek() === '=' || this.peek() === '>')) {
        const op = ch + this.peek();
        tokens.push(this.createToken(TokenType.OPERATOR, op, op, 2));
        continue;
      }

      if (ch === '>' && this.peek() === '=') {
        tokens.push(this.createToken(TokenType.OPERATOR, '>=', '>=', 2));
        continue;
      }

      // Single-character punctuation
      if (ch === ';' || ch === ',' || ch === '(' || ch === ')' || ch === '.' || ch === '[' || ch === ']') {
        tokens.push(this.createToken(TokenType.PUNCTUATION, ch, ch, 1));
        continue;
      }

      // Single-character operators
      if (ch === '=' || ch === '<' || ch === '>' || ch === '+' || ch === '-' || ch === '*' || ch === '/') {
        tokens.push(this.createToken(TokenType.OPERATOR, ch, ch, 1));
        continue;
      }

      // Identifiers or Keywords
      if (this.isIdentifierStart(ch)) {
        tokens.push(this.readIdentifierOrKeyword());
        continue;
      }

      // Any other single character fallback
      tokens.push(this.createToken(TokenType.OPERATOR, ch, ch, 1));
    }

    tokens.push({
      type: TokenType.EOF,
      value: '',
      raw: '',
      line: this.line,
      column: this.column,
      offset: this.pos,
    });

    return tokens;
  }

  private peek(offset: number = 1): string {
    const idx = this.pos + offset;
    return idx < this.length ? this.input[idx] : '';
  }

  private advance(count: number = 1): void {
    for (let i = 0; i < count; i++) {
      if (this.pos >= this.length) break;
      const ch = this.input[this.pos];
      this.pos++;
      if (ch === '\n') {
        this.line++;
        this.column = 1;
      } else {
        this.column++;
      }
    }
  }

  private isWhitespace(ch: string): boolean {
    return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v';
  }

  private isDigit(ch: string): boolean {
    return ch >= '0' && ch <= '9';
  }

  private isIdentifierStart(ch: string): boolean {
    return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_' || ch > '\u007F';
  }

  private isIdentifierPart(ch: string): boolean {
    return this.isIdentifierStart(ch) || this.isDigit(ch) || ch === '$';
  }

  private createToken(type: TokenType, value: string, raw: string, advanceCount: number): Token {
    const startLine = this.line;
    const startCol = this.column;
    const startOffset = this.pos;
    this.advance(advanceCount);
    return {
      type,
      value,
      raw,
      line: startLine,
      column: startCol,
      offset: startOffset,
    };
  }

  private readWhitespace(): Token {
    const startLine = this.line;
    const startCol = this.column;
    const startOffset = this.pos;
    let raw = '';

    while (this.pos < this.length && this.isWhitespace(this.input[this.pos])) {
      raw += this.input[this.pos];
      this.advance(1);
    }

    return {
      type: TokenType.WHITESPACE,
      value: raw,
      raw,
      line: startLine,
      column: startCol,
      offset: startOffset,
    };
  }

  private readSingleLineComment(): Token {
    const startLine = this.line;
    const startCol = this.column;
    const startOffset = this.pos;
    let raw = '';

    while (this.pos < this.length && this.input[this.pos] !== '\n' && this.input[this.pos] !== '\r') {
      raw += this.input[this.pos];
      this.advance(1);
    }

    // Capture the newline as well if present, to keep stream safe
    if (this.pos < this.length && (this.input[this.pos] === '\r' || this.input[this.pos] === '\n')) {
      if (this.input[this.pos] === '\r' && this.peek() === '\n') {
        raw += '\r\n';
        this.advance(2);
      } else {
        raw += this.input[this.pos];
        this.advance(1);
      }
    }

    return {
      type: TokenType.COMMENT,
      value: raw.trim(),
      raw,
      line: startLine,
      column: startCol,
      offset: startOffset,
    };
  }

  private readMultiLineComment(): Token {
    const startLine = this.line;
    const startCol = this.column;
    const startOffset = this.pos;
    let raw = '';

    // Consume /*
    raw += this.input[this.pos];
    raw += this.input[this.pos + 1];
    this.advance(2);

    while (this.pos < this.length) {
      if (this.input[this.pos] === '*' && this.peek() === '/') {
        raw += '*/';
        this.advance(2);
        break;
      }
      raw += this.input[this.pos];
      this.advance(1);
    }

    return {
      type: TokenType.COMMENT,
      value: raw,
      raw,
      line: startLine,
      column: startCol,
      offset: startOffset,
    };
  }

  private isDollarQuoteStart(): boolean {
    // PostgreSQL dollar-quote tag grammar: $[A-Za-z_\u0080-\uFFFF][A-Za-z0-9_\u0080-\uFFFF]*$
    // or just $$ (empty tag). Tags CANNOT start with a digit.
    // See: https://www.postgresql.org/docs/current/sql-syntax-lexical.html#SQL-SYNTAX-DOLLAR-QUOTING
    let idx = this.pos + 1;

    // Empty tag: $$ — the very next char is the closing $
    if (idx < this.length && this.input[idx] === '$') {
      return true;
    }

    // Non-empty tag: first char must be a letter or underscore (not digit, not $)
    if (idx >= this.length || !this.isIdentifierStart(this.input[idx])) {
      return false;
    }
    idx++;

    // Subsequent tag chars: letters, digits, underscores (no embedded $)
    while (idx < this.length) {
      const c = this.input[idx];
      if (c === '$') {
        return true; // found the closing $
      }
      if (!this.isIdentifierStart(c) && !this.isDigit(c)) {
        return false; // invalid tag char
      }
      idx++;
    }
    return false; // reached EOF without finding closing $
  }

  private readDollarString(): Token {
    const startLine = this.line;
    const startCol = this.column;
    const startOffset = this.pos;

    // Find the opening tag
    let tag = '$';
    let idx = this.pos + 1;
    while (idx < this.length && this.input[idx] !== '$') {
      tag += this.input[idx];
      idx++;
    }
    tag += '$'; // e.g. "$$" or "$func$"

    const tagLen = tag.length;
    let raw = '';

    // Consume the opening tag
    for (let i = 0; i < tagLen; i++) {
      raw += this.input[this.pos];
      this.advance(1);
    }

    // Read until matching closing tag
    while (this.pos < this.length) {
      if (this.input.startsWith(tag, this.pos)) {
        for (let i = 0; i < tagLen; i++) {
          raw += this.input[this.pos];
          this.advance(1);
        }
        break;
      }
      raw += this.input[this.pos];
      this.advance(1);
    }

    const value = raw.length >= tagLen * 2 ? raw.slice(tagLen, -tagLen) : raw;
    return {
      type: TokenType.DOLLAR_STRING,
      value,
      raw,
      line: startLine,
      column: startCol,
      offset: startOffset,
    };
  }

  private readSingleQuotedString(): Token {
    const startLine = this.line;
    const startCol = this.column;
    const startOffset = this.pos;
    let raw = "'";
    let value = '';
    this.advance(1); // skip initial '

    while (this.pos < this.length) {
      const ch = this.input[this.pos];
      if (ch === "'") {
        if (this.peek() === "'") {
          // Escaped quote ''
          raw += "''";
          value += "'";
          this.advance(2);
          continue;
        } else {
          // End of string
          raw += "'";
          this.advance(1);
          break;
        }
      } else if (ch === '\\' && this.peek() === "'") {
        // Escaped quote \'
        raw += "\\'";
        value += "'";
        this.advance(2);
        continue;
      } else {
        raw += ch;
        value += ch;
        this.advance(1);
      }
    }

    return {
      type: TokenType.STRING,
      value,
      raw,
      line: startLine,
      column: startCol,
      offset: startOffset,
    };
  }

  private readQuotedIdentifier(): Token {
    const startLine = this.line;
    const startCol = this.column;
    const startOffset = this.pos;
    let raw = '"';
    let value = '';
    this.advance(1); // skip initial "

    while (this.pos < this.length) {
      const ch = this.input[this.pos];
      if (ch === '"') {
        if (this.peek() === '"') {
          // Escaped double quote ""
          raw += '""';
          value += '"';
          this.advance(2);
          continue;
        } else {
          // End of quoted identifier
          raw += '"';
          this.advance(1);
          break;
        }
      } else {
        raw += ch;
        value += ch;
        this.advance(1);
      }
    }

    return {
      type: TokenType.IDENTIFIER,
      value,
      raw,
      line: startLine,
      column: startCol,
      offset: startOffset,
    };
  }

  private readNumber(): Token {
    const startLine = this.line;
    const startCol = this.column;
    const startOffset = this.pos;
    let raw = '';

    while (this.pos < this.length && (this.isDigit(this.input[this.pos]) || (this.input[this.pos] === '.' && this.isDigit(this.peek())))) {
      raw += this.input[this.pos];
      this.advance(1);
    }

    return {
      type: TokenType.NUMBER,
      value: raw,
      raw,
      line: startLine,
      column: startCol,
      offset: startOffset,
    };
  }

  private readIdentifierOrKeyword(): Token {
    const startLine = this.line;
    const startCol = this.column;
    const startOffset = this.pos;
    let raw = '';

    while (this.pos < this.length && this.isIdentifierPart(this.input[this.pos])) {
      raw += this.input[this.pos];
      this.advance(1);
    }

    const upper = raw.toUpperCase();
    const isKeyword = SQL_KEYWORDS.has(upper);

    return {
      type: isKeyword ? TokenType.KEYWORD : TokenType.IDENTIFIER,
      value: isKeyword ? upper : raw,
      raw,
      line: startLine,
      column: startCol,
      offset: startOffset,
    };
  }
}

/**
 * Splits SQL into discrete executable statements while tracking comments,
 * source coordinates, and inline lint directives.
 */
export function splitStatements(sql: string): Statement[] {
  if (sql.charCodeAt(0) === 0xFEFF) {
    sql = sql.slice(1);
  }
  const tokenizer = new SqlTokenizer(sql);
  const allTokens = tokenizer.tokenize({ includeWhitespace: false, includeComments: true });

  const statements: Statement[] = [];
  let currentTokens: Token[] = [];
  let pendingComments: string[] = [];
  let statementComments: string[] = [];

  for (const token of allTokens) {
    if (token.type === TokenType.COMMENT) {
      pendingComments.push(token.value);
      continue;
    }

    if (token.type === TokenType.EOF) {
      break;
    }

    if (token.type === TokenType.PUNCTUATION && token.value === ';') {
      if (currentTokens.length > 0) {
        statements.push(createStatement(currentTokens, [...statementComments, ...pendingComments]));
        currentTokens = [];
        statementComments = [];
        pendingComments = [];
      }
      continue;
    }

    // Attach any comments encountered prior to the first token of a statement
    if (currentTokens.length === 0 && pendingComments.length > 0) {
      statementComments = [...pendingComments];
      pendingComments = [];
    }

    currentTokens.push(token);
  }

  // Handle trailing statement without semicolon
  if (currentTokens.length > 0) {
    statements.push(createStatement(currentTokens, [...statementComments, ...pendingComments]));
  }

  return statements;
}

function createStatement(tokens: Token[], comments: string[]): Statement {
  const startLine = tokens[0]?.line ?? 1;
  const startColumn = tokens[0]?.column ?? 1;
  const lastToken = tokens[tokens.length - 1];
  const endLine = lastToken?.line ?? startLine;
  const endColumn = (lastToken?.column ?? startColumn) + (lastToken?.raw.length ?? 0);

  const raw = tokens.map(t => t.raw).join(' ');

  return {
    raw,
    tokens,
    comments,
    startLine,
    startColumn,
    endLine,
    endColumn,
    hasIgnore(ruleId?: string): boolean {
      for (const comment of comments) {
        const lower = comment.toLowerCase();
        // Check standard ignore patterns:
        // -- ddlforge-ignore
        // -- ddlforge-disable
        // -- ddlforge-ignore <ruleId>
        if (lower.includes('ddlforge-ignore') || lower.includes('ddlforge-disable')) {
          if (!ruleId) return true;
          if (lower.includes(ruleId.toLowerCase())) return true;
          // Bare ignore comment applies to all rules for that statement
          const match = lower.match(/ddlforge-(?:ignore|disable)(.*)$/);
          if (match && match[1].trim() === '') {
            return true;
          }
        }
      }
      return false;
    },
  };
}

export function tokenize(sql: string, options?: LexerOptions): Token[] {
  const tokenizer = new SqlTokenizer(sql);
  return tokenizer.tokenize(options);
}

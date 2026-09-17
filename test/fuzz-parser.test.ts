/**
 * ddlforge - Adversarial fuzz test suite for the SQL lexer and statement splitter
 *
 * Covers 35+ edge cases: dollar-quoting, block/line comments, string literals,
 * operators, line endings, identifiers, numeric literals, and more.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { splitStatements, tokenize } from '../src/lexer/sqlTokenizer.js';
import { TokenType } from '../src/lexer/tokens.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tokenTypes(sql: string): TokenType[] {
  return tokenize(sql).map((t) => t.type);
}

function tokenValues(sql: string): string[] {
  return tokenize(sql).map((t) => t.value);
}

function nonEofTokens(sql: string) {
  return tokenize(sql).filter((t) => t.type !== TokenType.EOF);
}

// ---------------------------------------------------------------------------
// 1. Dollar-quoted strings
// ---------------------------------------------------------------------------

describe('Dollar-quoted strings', () => {
  it('1.1 Basic $$ string with semicolon inside is one statement', () => {
    const sql = `CREATE FUNCTION f() RETURNS void AS $$ BEGIN RETURN; END; $$ LANGUAGE plpgsql;`;
    const stmts = splitStatements(sql);
    assert.strictEqual(stmts.length, 1, 'semicolons inside $$ must not split');
  });

  it('1.2 Named tag $func$ string with semicolons inside is one statement', () => {
    const sql = `CREATE FUNCTION g() RETURNS void AS $func$ BEGIN SELECT 1; SELECT 2; END; $func$ LANGUAGE plpgsql;`;
    const stmts = splitStatements(sql);
    assert.strictEqual(stmts.length, 1, 'semicolons inside $func$ must not split');
  });

  it('1.3 Named tag $body$ string with semicolons inside is one statement', () => {
    const sql = `DO $body$ BEGIN RAISE NOTICE 'ok;'; END; $body$;`;
    const stmts = splitStatements(sql);
    assert.strictEqual(stmts.length, 1);
  });

  it('1.4 Outer dollar-quoted string contains a different inner tag (no interference)', () => {
    // $outer$ ... $inner$ ... $inner$ ... $outer$ — lexer should treat $inner$ as plain text
    const sql = `DO $outer$ DECLARE s text := $inner$hello; world$inner$; BEGIN NULL; END; $outer$;`;
    const stmts = splitStatements(sql);
    assert.strictEqual(stmts.length, 1, 'inner different tag inside outer tag must be ignored');
  });

  it('1.5 Empty dollar-quoted string $$$$', () => {
    const tokens = nonEofTokens('$$$$');
    assert.strictEqual(tokens.length, 1);
    assert.strictEqual(tokens[0].type, TokenType.DOLLAR_STRING);
    assert.strictEqual(tokens[0].value, '', 'empty dollar string value must be empty');
  });

  it('1.6 Dollar-quoted body with tag containing only underscores: $__$', () => {
    const sql = `DO $__$ BEGIN NULL; END; $__$;`;
    const stmts = splitStatements(sql);
    assert.strictEqual(stmts.length, 1);
  });

  it('1.7 Dollar-quoted string followed by another statement', () => {
    const sql = `SELECT $$hello; world$$; SELECT 1;`;
    const stmts = splitStatements(sql);
    assert.strictEqual(stmts.length, 2);
  });

  it('1.8 Dollar-quoted string with tag containing digits ($tag1$) still works', () => {
    // $tag1$ starts with a letter, has digit later — this is valid PG syntax
    const sql = `SELECT $tag1$content;here$tag1$;`;
    const stmts = splitStatements(sql);
    assert.strictEqual(stmts.length, 1, '$tag1$ is a valid dollar-quote tag');
    // The token should be DOLLAR_STRING
    const tokens = nonEofTokens(`$tag1$content$tag1$`);
    assert.ok(tokens.some((t) => t.type === TokenType.DOLLAR_STRING));
  });

  it('1.8b Tags starting with a digit ($1 param) are rejected per PostgreSQL spec', () => {
    // PostgreSQL does NOT allow dollar-quote tags that start with a digit.
    // $1 as a positional parameter should decompose into OPERATOR($) + NUMBER(1).
    // At no point should a runaway DOLLAR_STRING span from $1 to a later $.
    const tokens = nonEofTokens(`SELECT id = $1`);
    // There must be no DOLLAR_STRING token — $1 should become OPERATOR + NUMBER
    const dollarStrings = tokens.filter((t) => t.type === TokenType.DOLLAR_STRING);
    assert.strictEqual(dollarStrings.length, 0, `$1 must not produce a DOLLAR_STRING token`);
    // $1 should be tokenized as separate $ (OPERATOR) and 1 (NUMBER)
    assert.ok(tokens.some((t) => t.type === TokenType.OPERATOR && t.value === '$'),
      'lone $ before a digit must be tokenized as OPERATOR');
    assert.ok(tokens.some((t) => t.type === TokenType.NUMBER && t.value === '1'),
      'digit after $ must be tokenized as NUMBER');
  });

  it('1.9 Unclosed dollar-quoted string at EOF does not crash', () => {
    assert.doesNotThrow(() => splitStatements(`SELECT $$unclosed`));
    assert.doesNotThrow(() => tokenize(`$func$unclosed body`));
  });

  it('1.10 CREATE FUNCTION with $$ body containing multiple semicolons — one statement', () => {
    const sql = `
      CREATE OR REPLACE FUNCTION multi() RETURNS void LANGUAGE plpgsql AS $$
      DECLARE
        x INT;
        y TEXT;
      BEGIN
        SELECT 1 INTO x;
        SELECT 'a;b;c' INTO y;
        RETURN;
      END;
      $$;
    `;
    const stmts = splitStatements(sql);
    assert.strictEqual(stmts.length, 1);
  });
});

// ---------------------------------------------------------------------------
// 2. C-style block comments
// ---------------------------------------------------------------------------

describe('C-style block comments', () => {
  it('2.1 Block comment with semicolons does not cause extra statement', () => {
    const sql = `SELECT 1 /* ; ; ; */;`;
    const stmts = splitStatements(sql);
    assert.strictEqual(stmts.length, 1);
  });

  it('2.2 Block comment containing single-quotes does not crash', () => {
    const sql = `SELECT 1 /* it\'s a "comment"; with quotes */;`;
    assert.doesNotThrow(() => tokenize(sql));
    const stmts = splitStatements(sql);
    assert.strictEqual(stmts.length, 1);
  });

  it('2.3 Unclosed block comment at EOF — should tokenize without crash', () => {
    assert.doesNotThrow(() => tokenize(`SELECT 1 /* unclosed comment`));
    assert.doesNotThrow(() => splitStatements(`SELECT 1 /* unclosed comment`));
  });

  it('2.4 Nested /* /* */ — lexer should not crash (PG does not truly nest)', () => {
    // PG parses the first */ as closing the entire comment; subsequent text may be visible.
    // Whatever the behavior, it must not throw.
    assert.doesNotThrow(() => tokenize(`/* outer /* inner */ still comment? */`));
    assert.doesNotThrow(() => splitStatements(`SELECT 1 /* a /* b */ c */;`));
  });

  it('2.5 Block comment between statements does not create extra statement', () => {
    const sql = `SELECT 1; /* between */ SELECT 2;`;
    const stmts = splitStatements(sql);
    assert.strictEqual(stmts.length, 2);
  });

  it('2.6 Statement with both block comment and line comment', () => {
    const sql = `/* block */ SELECT /* mid */ 1 -- inline\n;`;
    const stmts = splitStatements(sql);
    assert.strictEqual(stmts.length, 1);
  });
});

// ---------------------------------------------------------------------------
// 3. Single-line comments
// ---------------------------------------------------------------------------

describe('Single-line comments', () => {
  it('3.1 Line comment with semicolon inside does not split statement', () => {
    const sql = `SELECT 1 -- this has a; semicolon\n;`;
    const stmts = splitStatements(sql);
    assert.strictEqual(stmts.length, 1);
  });

  it('3.2 Multiple line comments between statements — only real statements counted', () => {
    const sql = `-- comment A\nSELECT 1;\n-- comment B\nSELECT 2;`;
    const stmts = splitStatements(sql);
    assert.strictEqual(stmts.length, 2);
  });

  it('3.3 Statement with --ddlforge-ignore directive — hasIgnore() returns true', () => {
    const sql = `-- ddlforge-ignore\nCREATE INDEX ON t(col);`;
    const stmts = splitStatements(sql);
    assert.strictEqual(stmts.length, 1);
    assert.ok(stmts[0].hasIgnore(), 'hasIgnore() must return true for ddlforge-ignore comment');
  });

  it('3.4 Statement WITHOUT ignore directive — hasIgnore() returns false', () => {
    const sql = `-- some other comment\nCREATE INDEX ON t(col);`;
    const stmts = splitStatements(sql);
    assert.strictEqual(stmts.length, 1);
    assert.ok(!stmts[0].hasIgnore(), 'hasIgnore() must return false without directive');
  });

  it('3.5 ddlforge-disable directive also triggers hasIgnore()', () => {
    const sql = `-- ddlforge-disable\nDROP TABLE t;`;
    const stmts = splitStatements(sql);
    assert.ok(stmts[0].hasIgnore());
  });
});

// ---------------------------------------------------------------------------
// 4. Single-quoted string literals
// ---------------------------------------------------------------------------

describe('Single-quoted string literals', () => {
  it('4.1 Semicolon inside single-quoted string does not split statement', () => {
    const sql = `SELECT 'a;b;c';`;
    const stmts = splitStatements(sql);
    assert.strictEqual(stmts.length, 1);
  });

  it('4.2 Escaped quote with doubled apostrophe inside string', () => {
    const tokens = nonEofTokens(`SELECT 'it''s fine'`);
    const str = tokens.find((t) => t.type === TokenType.STRING);
    assert.ok(str, 'STRING token must be found');
    assert.strictEqual(str!.value, "it's fine");
  });

  it('4.3 Escaped string literal E\'don\'\'t stop\'', () => {
    // E'...' — lexer handles the leading E as identifier, ' as string start
    const sql = `SELECT E'don''t stop';`;
    assert.doesNotThrow(() => splitStatements(sql));
    const stmts = splitStatements(sql);
    assert.strictEqual(stmts.length, 1);
  });

  it('4.4 Escape string e\'hello\\nworld\' lowercase prefix', () => {
    const sql = `SELECT e'hello\\nworld';`;
    assert.doesNotThrow(() => splitStatements(sql));
  });

  it('4.5 Adjacent string literals: SELECT \'a\' \'b\' — one statement', () => {
    const sql = `SELECT 'a' 'b';`;
    const stmts = splitStatements(sql);
    assert.strictEqual(stmts.length, 1);
  });

  it('4.6 Unicode string U&\'\\0041\' tokenizes as STRING', () => {
    const sql = `SELECT U&'\\0041';`;
    const tokens = nonEofTokens(sql);
    // U& is an identifier, then STRING for the quoted part
    const strTokens = tokens.filter((t) => t.type === TokenType.STRING);
    assert.ok(strTokens.length >= 1, 'At least one STRING token expected');
  });

  it('4.7 Unclosed single-quoted string at EOF does not crash', () => {
    assert.doesNotThrow(() => tokenize(`SELECT 'unclosed`));
    assert.doesNotThrow(() => splitStatements(`SELECT 'unclosed`));
  });
});

// ---------------------------------------------------------------------------
// 5. Quoted identifiers
// ---------------------------------------------------------------------------

describe('Quoted identifiers', () => {
  it('5.1 Dotted quoted identifier: "public"."users"', () => {
    const tokens = nonEofTokens(`SELECT "public"."users"`);
    const idents = tokens.filter((t) => t.type === TokenType.IDENTIFIER);
    assert.strictEqual(idents.length, 2, 'Two quoted identifiers expected');
    assert.strictEqual(idents[0].value, 'public');
    assert.strictEqual(idents[1].value, 'users');
  });

  it('5.2 Quoted identifier with embedded double-quote: "or""der"', () => {
    const tokens = nonEofTokens(`"or""der"`);
    const ident = tokens.find((t) => t.type === TokenType.IDENTIFIER);
    assert.ok(ident, 'IDENTIFIER token must be found');
    assert.strictEqual(ident!.value, 'or"der', 'Escaped "" must become single "');
  });

  it('5.3 Keyword as quoted identifier: "select" is IDENTIFIER not KEYWORD', () => {
    const tokens = nonEofTokens(`CREATE TABLE "select" (id INT)`);
    const selectToken = tokens.find((t) => t.raw === '"select"');
    assert.ok(selectToken, '"select" token must exist');
    assert.strictEqual(selectToken!.type, TokenType.IDENTIFIER);
  });

  it('5.4 CREATE TABLE with quoted identifier — splitStatements produces 1 statement', () => {
    const sql = `CREATE TABLE "my table" (id INT);`;
    const stmts = splitStatements(sql);
    assert.strictEqual(stmts.length, 1);
  });

  it('5.5 Unclosed quoted identifier at EOF does not crash', () => {
    assert.doesNotThrow(() => tokenize(`SELECT "unclosed`));
  });
});

// ---------------------------------------------------------------------------
// 6. Numeric literals
// ---------------------------------------------------------------------------

describe('Numeric literals', () => {
  it('6.1 Integer literal — NUMBER token', () => {
    const tokens = nonEofTokens('SELECT 100');
    const num = tokens.find((t) => t.type === TokenType.NUMBER);
    assert.ok(num);
    assert.strictEqual(num!.value, '100');
  });

  it('6.2 Decimal literal 1.5 — NUMBER token', () => {
    const tokens = nonEofTokens('SELECT 1.5');
    const num = tokens.find((t) => t.type === TokenType.NUMBER);
    assert.ok(num);
    assert.strictEqual(num!.value, '1.5');
  });

  it('6.3 Leading-dot decimal .5 — at minimum does not crash', () => {
    // The lexer may tokenize this as PUNCTUATION('.') + NUMBER('5')
    // or as NUMBER('.5') — either is acceptable, no crash
    assert.doesNotThrow(() => tokenize('SELECT .5'));
  });

  it('6.4 Positional parameter $1 does not cause dollar-string runaway', () => {
    // $1 is a positional parameter — the $ should NOT start a dollar-quoted string
    // because there is no matching closing $ after `1`. The lexer must not consume
    // past the whitespace/next-token boundary trying to find a closing tag.
    const sql = `SELECT * FROM t WHERE id = $1 AND name = $2`;
    assert.doesNotThrow(() => tokenize(sql));
    // Should produce tokens for SELECT, *, FROM, t, WHERE, id, =, and then
    // something for $1 (likely OPERATOR or IDENTIFIER), not a DOLLAR_STRING
    const tokens = nonEofTokens(sql);
    // The key check: no DOLLAR_STRING token should span from $1 to $2
    const dollarStrings = tokens.filter((t) => t.type === TokenType.DOLLAR_STRING);
    // If a DOLLAR_STRING is found, its value must not span the entire rest of input
    for (const ds of dollarStrings) {
      assert.ok(
        ds.raw.length < sql.length,
        `Dollar string raw '${ds.raw}' must not consume whole input`,
      );
    }
  });

  it('6.5 Type cast :: in numeric context — OPERATOR token', () => {
    const tokens = nonEofTokens(`SELECT 42::bigint`);
    const cast = tokens.find((t) => t.value === '::');
    assert.ok(cast, ':: token must exist');
    assert.strictEqual(cast!.type, TokenType.OPERATOR);
  });
});

// ---------------------------------------------------------------------------
// 7. Operators and punctuation
// ---------------------------------------------------------------------------

describe('Operators and punctuation', () => {
  it('7.1 :: type cast operator is OPERATOR token', () => {
    const tokens = nonEofTokens(`col::regclass`);
    const cast = tokens.find((t) => t.value === '::');
    assert.ok(cast);
    assert.strictEqual(cast!.type, TokenType.OPERATOR);
  });

  it('7.2 :: with complex type col::numeric(10,2)', () => {
    const sql = `SELECT price::numeric(10,2)`;
    assert.doesNotThrow(() => tokenize(sql));
    const tokens = nonEofTokens(sql);
    assert.ok(tokens.some((t) => t.value === '::'));
  });

  it('7.3 != operator is OPERATOR token', () => {
    const tokens = nonEofTokens(`WHERE a != b`);
    const op = tokens.find((t) => t.value === '!=');
    assert.ok(op);
    assert.strictEqual(op!.type, TokenType.OPERATOR);
  });

  it('7.4 <= operator is OPERATOR token', () => {
    const tokens = nonEofTokens(`WHERE a <= 10`);
    const op = tokens.find((t) => t.value === '<=');
    assert.ok(op);
    assert.strictEqual(op!.type, TokenType.OPERATOR);
  });

  it('7.5 >= operator is OPERATOR token', () => {
    const tokens = nonEofTokens(`WHERE a >= 10`);
    const op = tokens.find((t) => t.value === '>=');
    assert.ok(op);
    assert.strictEqual(op!.type, TokenType.OPERATOR);
  });

  it('7.6 <> operator is OPERATOR token', () => {
    const tokens = nonEofTokens(`WHERE a <> b`);
    const op = tokens.find((t) => t.value === '<>');
    assert.ok(op);
    assert.strictEqual(op!.type, TokenType.OPERATOR);
  });
});

// ---------------------------------------------------------------------------
// 8. Empty / whitespace / degenerate inputs
// ---------------------------------------------------------------------------

describe('Empty and degenerate inputs', () => {
  it('8.1 Empty string — returns 0 statements', () => {
    assert.strictEqual(splitStatements('').length, 0);
  });

  it('8.2 Only whitespace — returns 0 statements', () => {
    assert.strictEqual(splitStatements('   \n\t  \r\n  ').length, 0);
  });

  it('8.3 Only a semicolon — returns 0 statements (empty filtered)', () => {
    assert.strictEqual(splitStatements(';').length, 0);
  });

  it('8.4 Multiple bare semicolons ;; — returns 0 statements', () => {
    assert.strictEqual(splitStatements(';;').length, 0);
  });

  it('8.5 Newlines-and-semicolons \\n\\n;\\n;\\n — returns 0 statements', () => {
    assert.strictEqual(splitStatements('\n\n;\n;\n').length, 0);
  });

  it('8.6 Only line comments — returns 0 statements', () => {
    const sql = `-- comment one\n-- comment two\n`;
    assert.strictEqual(splitStatements(sql).length, 0);
  });
});

// ---------------------------------------------------------------------------
// 9. Statement splitting edge cases
// ---------------------------------------------------------------------------

describe('Statement splitting edge cases', () => {
  it('9.1 Trailing statement without semicolon is captured', () => {
    const sql = `SELECT 1;\nSELECT 2`;
    const stmts = splitStatements(sql);
    assert.strictEqual(stmts.length, 2);
  });

  it('9.2 Leading and trailing whitespace does not add statements', () => {
    const sql = `\n\n  SELECT 1;  \n\n`;
    const stmts = splitStatements(sql);
    assert.strictEqual(stmts.length, 1);
  });

  it('9.3 Comments between statements are not counted as statements', () => {
    const sql = `SELECT 1;\n-- comment\nSELECT 2;`;
    const stmts = splitStatements(sql);
    assert.strictEqual(stmts.length, 2);
  });

  it('9.4 CREATE UNIQUE INDEX CONCURRENTLY — produces 1 statement', () => {
    const sql = `CREATE UNIQUE INDEX CONCURRENTLY idx_name ON t(col);`;
    const stmts = splitStatements(sql);
    assert.strictEqual(stmts.length, 1);
  });

  it('9.5 REINDEX CONCURRENTLY — produces 1 statement', () => {
    const sql = `REINDEX (CONCURRENTLY) TABLE t;`;
    const stmts = splitStatements(sql);
    assert.strictEqual(stmts.length, 1);
  });

  it('9.6 Multi-column ALTER TABLE with nested parens in CHECK expression', () => {
    const sql = `ALTER TABLE t
      ADD COLUMN a INT CHECK (a > 0 AND (a < 100 OR a = 999)),
      ADD COLUMN b TEXT NOT NULL;`;
    const stmts = splitStatements(sql);
    assert.strictEqual(stmts.length, 1);
  });

  it('9.7 Statement source coordinates: startLine and endLine are plausible', () => {
    const sql = `SELECT 1;\nSELECT 2;`;
    const stmts = splitStatements(sql);
    assert.strictEqual(stmts[0].startLine, 1);
    assert.strictEqual(stmts[1].startLine, 2);
  });

  it('9.8 Three statements in sequence', () => {
    const sql = `SELECT 1; SELECT 2; SELECT 3;`;
    assert.strictEqual(splitStatements(sql).length, 3);
  });
});

// ---------------------------------------------------------------------------
// 10. Line ending and whitespace forms
// ---------------------------------------------------------------------------

describe('Line endings and unusual whitespace', () => {
  it('10.1 CRLF (\\r\\n) line endings — line count increments correctly', () => {
    const sql = `SELECT 1;\r\nSELECT 2;\r\n`;
    const stmts = splitStatements(sql);
    assert.strictEqual(stmts.length, 2);
    assert.strictEqual(stmts[0].startLine, 1);
    assert.strictEqual(stmts[1].startLine, 2);
  });

  it('10.2 Mixed \\r\\n and \\n line endings do not crash', () => {
    const sql = `SELECT 1;\r\nSELECT 2;\nSELECT 3;\r\n`;
    assert.doesNotThrow(() => splitStatements(sql));
    assert.strictEqual(splitStatements(sql).length, 3);
  });

  it('10.3 Tab character in statement body is treated as whitespace', () => {
    const sql = `SELECT\t1\t+\t2;`;
    const stmts = splitStatements(sql);
    assert.strictEqual(stmts.length, 1);
  });

  it('10.4 Form-feed \\f character does not crash tokenizer', () => {
    const sql = `SELECT\f1;`;
    assert.doesNotThrow(() => tokenize(sql));
  });

  it('10.5 NULL byte in input does not crash tokenizer', () => {
    const sql = `SELECT 1\0;`;
    assert.doesNotThrow(() => tokenize(sql));
  });
});

// ---------------------------------------------------------------------------
// 11. Identifiers and keywords
// ---------------------------------------------------------------------------

describe('Identifiers and keywords', () => {
  it('11.1 Very long identifier (200 chars) tokenizes without crash', () => {
    const longId = 'a'.repeat(200);
    assert.doesNotThrow(() => tokenize(`SELECT ${longId}`));
    const tokens = nonEofTokens(`SELECT ${longId}`);
    const ident = tokens.find((t) => t.type === TokenType.IDENTIFIER);
    assert.ok(ident);
    assert.strictEqual(ident!.value, longId);
  });

  it('11.2 Keyword tokens are uppercased in value', () => {
    const tokens = nonEofTokens('create table');
    const kw = tokens.filter((t) => t.type === TokenType.KEYWORD);
    assert.ok(kw.some((t) => t.value === 'CREATE'));
    assert.ok(kw.some((t) => t.value === 'TABLE'));
  });

  it('11.3 Identifier that starts with underscore is valid', () => {
    const tokens = nonEofTokens('SELECT _private');
    const ident = tokens.find((t) => t.type === TokenType.IDENTIFIER);
    assert.ok(ident);
    assert.strictEqual(ident!.value, '_private');
  });

  it('11.4 Identifier with $ in the middle (PG extension) tokenizes', () => {
    // PG allows $ in identifier bodies (for internal use)
    const tokens = nonEofTokens('SELECT foo$bar');
    const ident = tokens.find((t) => t.type === TokenType.IDENTIFIER);
    assert.ok(ident);
    assert.strictEqual(ident!.value, 'foo$bar');
  });

  it('11.5 Non-ASCII identifier character (Unicode letter) is valid', () => {
    // Identifiers can start with chars > U+007F in the lexer
    assert.doesNotThrow(() => tokenize('SELECT café'));
  });
});

// ---------------------------------------------------------------------------
// 12. Token EOF and stream integrity
// ---------------------------------------------------------------------------

describe('Token stream integrity', () => {
  it('12.1 tokenize() always ends with an EOF token', () => {
    const tokens = tokenize('SELECT 1');
    assert.strictEqual(tokens[tokens.length - 1].type, TokenType.EOF);
  });

  it('12.2 tokenize() on empty string has exactly one token (EOF)', () => {
    const tokens = tokenize('');
    assert.strictEqual(tokens.length, 1);
    assert.strictEqual(tokens[0].type, TokenType.EOF);
  });

  it('12.3 Token offsets are non-decreasing', () => {
    const tokens = tokenize('SELECT id, name FROM users WHERE id = 1;');
    let prev = -1;
    for (const t of tokens) {
      assert.ok(t.offset >= prev, `Offset ${t.offset} decreased from ${prev}`);
      prev = t.offset;
    }
  });

  it('12.4 Token line numbers are non-decreasing', () => {
    const tokens = tokenize('SELECT 1;\nSELECT 2;\nSELECT 3;');
    let prev = 0;
    for (const t of tokens) {
      assert.ok(t.line >= prev, `Line ${t.line} decreased from ${prev}`);
      prev = t.line;
    }
  });

  it('12.5 All tokens have positive line and column numbers', () => {
    const tokens = tokenize('SELECT a, b FROM t');
    for (const t of tokens) {
      assert.ok(t.line >= 1, `Line must be >= 1, got ${t.line}`);
      assert.ok(t.column >= 1, `Column must be >= 1, got ${t.column}`);
    }
  });
});

// ---------------------------------------------------------------------------
// 13. Comment attachment to statements
// ---------------------------------------------------------------------------

describe('Comment attachment', () => {
  it('13.1 Leading line comment is attached to the following statement', () => {
    const sql = `-- my comment\nSELECT 1;`;
    const stmts = splitStatements(sql);
    assert.strictEqual(stmts.length, 1);
    assert.ok(stmts[0].comments.some((c) => c.includes('my comment')));
  });

  it('13.2 Leading block comment is attached to the following statement', () => {
    const sql = `/* header */ SELECT 1;`;
    const stmts = splitStatements(sql);
    assert.ok(stmts[0].comments.some((c) => c.includes('header')));
  });

  it('13.3 Comment between two statements attaches to the second', () => {
    const sql = `SELECT 1;\n-- between\nSELECT 2;`;
    const stmts = splitStatements(sql);
    assert.strictEqual(stmts.length, 2);
    assert.ok(stmts[1].comments.some((c) => c.includes('between')));
  });
});

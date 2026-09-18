/**
 * ddlforge - Byte-Offset Statement Slicer & Migration Splitter
 *
 * Classifies statements into TRANSACTIONAL vs AUTOCOMMIT and slices
 * raw SQL based on exact source byte/character offsets, preserving
 * comments, formatting, and indentation without AST deparsing.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Statement, Token } from '../lexer/tokens.js';
import { splitStatements } from '../lexer/sqlTokenizer.js';

export type StatementClass = 'TRANSACTIONAL' | 'AUTOCOMMIT';

export interface SlicedStatement {
  statement: Statement;
  classification: StatementClass;
  text: string;
  startOffset: number;
  endOffset: number;
}

export interface SlicedMigration {
  statements: SlicedStatement[];
  phase1Transactional: SlicedStatement[];
  phase2Autocommit: SlicedStatement[];
  phase1Sql: string;
  phase2Sql: string;
  isMixed: boolean;
  isClean: boolean;
}

export interface SliceOptions {
  isPrisma?: boolean;
}

/**
 * Determines whether a statement requires autocommit mode in PostgreSQL.
 * Autocommit statements cannot execute inside an explicit BEGIN...COMMIT block.
 */
export function isAutocommitStatement(stmt: Statement): boolean {
  const tokens = stmt.tokens;
  if (tokens.length === 0) return false;

  const t0 = tokens[0].value;
  const t1 = tokens[1]?.value;

  // 1. CREATE [UNIQUE] INDEX CONCURRENTLY
  if (t0 === 'CREATE') {
    let idx = 1;
    if (tokens[idx]?.value === 'UNIQUE') idx++;
    if (tokens[idx]?.value === 'INDEX') {
      for (let i = idx + 1; i < tokens.length; i++) {
        if (tokens[i].value === 'ON') break;
        if (tokens[i].value === 'CONCURRENTLY') return true;
      }
    }
  }

  // 2. DROP INDEX CONCURRENTLY
  if (t0 === 'DROP' && t1 === 'INDEX') {
    for (let i = 2; i < tokens.length; i++) {
      if (tokens[i].value === 'CONCURRENTLY') return true;
    }
  }

  // 3. REINDEX ... CONCURRENTLY
  if (t0 === 'REINDEX') {
    for (let i = 1; i < tokens.length; i++) {
      if (tokens[i].value === 'CONCURRENTLY') return true;
    }
  }

  // 4. VACUUM (any form: VACUUM, VACUUM FULL, VACUUM ANALYZE, etc.)
  if (t0 === 'VACUUM') {
    return true;
  }

  // 5. ALTER TYPE ... ADD VALUE
  if (t0 === 'ALTER' && t1 === 'TYPE') {
    for (let i = 2; i < tokens.length - 1; i++) {
      if (tokens[i].value === 'ADD' && tokens[i + 1]?.value === 'VALUE') {
        return true;
      }
    }
  }

  // 6. ALTER TABLE ... DETACH PARTITION ... CONCURRENTLY
  if (t0 === 'ALTER' && t1 === 'TABLE') {
    for (let i = 2; i < tokens.length - 1; i++) {
      if (tokens[i].value === 'DETACH' && tokens[i + 1]?.value === 'PARTITION') {
        for (let j = i + 2; j < tokens.length; j++) {
          if (tokens[j].value === 'CONCURRENTLY') return true;
        }
      }
    }
  }

  // 7. DISCARD ALL
  if (t0 === 'DISCARD') {
    return true;
  }

  return false;
}

/**
 * Classifies an AST statement into 'TRANSACTIONAL' or 'AUTOCOMMIT'.
 */
export function classifyStatement(stmt: Statement): StatementClass {
  return isAutocommitStatement(stmt) ? 'AUTOCOMMIT' : 'TRANSACTIONAL';
}

/**
 * Slices raw SQL input based on byte/character offset boundaries of statements.
 * Preserves all inline/block comments, whitespace, indentation, and formatting.
 */
export function sliceMigration(
  rawSql: string,
  statements?: Statement[],
  options: SliceOptions = {}
): SlicedMigration {
  let workingSql = rawSql;
  if (workingSql.charCodeAt(0) === 0xFEFF) {
    workingSql = workingSql.slice(1);
  }

  const stmts = statements ?? splitStatements(workingSql);

  const slicedStatements: SlicedStatement[] = stmts.map(stmt => {
    const classification = classifyStatement(stmt);
    let text = '';
    if (stmt.endOffset > stmt.startOffset && stmt.endOffset <= workingSql.length) {
      text = workingSql.slice(stmt.startOffset, stmt.endOffset);
    } else if (stmt.tokens.length > 0) {
      const firstTok = stmt.tokens[0];
      const lastTok = stmt.tokens[stmt.tokens.length - 1];
      text = workingSql.slice(firstTok.offset, lastTok.offset + lastTok.raw.length);
    } else {
      text = stmt.raw;
    }

    return {
      statement: stmt,
      classification,
      text,
      startOffset: stmt.startOffset,
      endOffset: stmt.endOffset,
    };
  });

  const phase1Transactional = slicedStatements.filter(s => s.classification === 'TRANSACTIONAL');
  const phase2Autocommit = slicedStatements.filter(s => s.classification === 'AUTOCOMMIT');

  const isMixed = phase1Transactional.length > 0 && phase2Autocommit.length > 0;
  const isClean = !isMixed;

  // Assemble phase 1 SQL
  const phase1Texts = phase1Transactional.map(s => s.text.trim()).filter(t => t.length > 0);
  const phase1Sql = phase1Texts.length > 0 ? phase1Texts.join('\n\n') + '\n' : '';

  // Assemble phase 2 SQL
  const isPrisma = options.isPrisma ?? (
    workingSql.includes('prisma-migrate') ||
    workingSql.includes('-- prisma') ||
    /--\s*(CreateTable|AlterTable|CreateIndex)/.test(workingSql)
  );

  const phase2Texts = phase2Autocommit.map(s => s.text.trim()).filter(t => t.length > 0);
  let phase2Sql = '';
  if (phase2Texts.length > 0) {
    if (
      isPrisma &&
      !phase2Texts.some(t =>
        t.includes('prisma-migrate-disable-next-transaction') ||
        t.includes('prisma:no-transaction')
      )
    ) {
      phase2Sql = '-- prisma-migrate-disable-next-transaction\n\n' + phase2Texts.join('\n\n') + '\n';
    } else {
      phase2Sql = phase2Texts.join('\n\n') + '\n';
    }
  }

  return {
    statements: slicedStatements,
    phase1Transactional,
    phase2Autocommit,
    phase1Sql,
    phase2Sql,
    isMixed,
    isClean,
  };
}

export interface SplitResult {
  phase1Path: string;
  phase2Path: string;
  result: SlicedMigration;
}

/**
 * Splits a mixed migration file on disk into two deterministic files:
 *   `<basename>_phase1_tx.sql`
 *   `<basename>_phase2_autocommit.sql`
 *
 * If the file is already clean (all transactional or all autocommit), returns null.
 */
export function splitMigrationFile(
  filePath: string,
  options: SliceOptions = {}
): SplitResult | null {
  const content = fs.readFileSync(filePath, 'utf-8');
  const result = sliceMigration(content, undefined, options);

  if (result.isClean) {
    return null;
  }

  const dir = path.dirname(filePath);
  const ext = path.extname(filePath) || '.sql';
  const base = path.basename(filePath, ext);

  const phase1Path = path.join(dir, `${base}_phase1_tx${ext}`);
  const phase2Path = path.join(dir, `${base}_phase2_autocommit${ext}`);

  fs.writeFileSync(phase1Path, result.phase1Sql, 'utf-8');
  fs.writeFileSync(phase2Path, result.phase2Sql, 'utf-8');

  return {
    phase1Path,
    phase2Path,
    result,
  };
}

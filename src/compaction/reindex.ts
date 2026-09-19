/**
 * ddlforge - Lock-Safe Index Reindexer
 *
 * Generates autocommit-safe concurrent reindexing statements and validates that
 * statements execute strictly outside explicit transaction blocks to prevent
 * PostgreSQL SQLSTATE 55000 (`REINDEX CONCURRENTLY cannot run inside a transaction block`).
 */

export interface ReindexOptions {
  table: string;
  index?: string;
  schema?: string;
  tablespace?: string;
}

export interface ReindexResult {
  sql: string;
  targetType: 'index' | 'table';
  targetIdentifier: string;
  requiresAutocommit: boolean;
  explanation: string;
}

/**
 * Generates lock-safe REINDEX CONCURRENTLY statements.
 */
export function generateReindexScript(options: ReindexOptions): ReindexResult {
  const schema = (options.schema || 'public').replace(/["`]/g, '');
  const table = options.table ? options.table.replace(/["`]/g, '') : '';
  const index = options.index ? options.index.replace(/["`]/g, '') : undefined;

  if (!table) {
    throw new Error('generateReindexScript: table name is required.');
  }

  let sql: string;
  let targetType: 'index' | 'table';
  let targetIdentifier: string;

  if (index) {
    targetType = 'index';
    targetIdentifier = `"${schema}"."${index}"`;
    sql = `REINDEX INDEX CONCURRENTLY "${schema}"."${index}";`;
  } else {
    targetType = 'table';
    targetIdentifier = `"${schema}"."${table}"`;
    sql = `REINDEX TABLE CONCURRENTLY "${schema}"."${table}";`;
  }

  return {
    sql,
    targetType,
    targetIdentifier,
    requiresAutocommit: true,
    explanation:
      'REINDEX CONCURRENTLY acquires a ShareUpdateExclusiveLock, permitting concurrent reads, inserts, updates, and deletes. It MUST run in autocommit mode (outside a transaction block).',
  };
}

/**
 * Validates that concurrent reindexing is not wrapped within an explicit transaction block.
 */
export function validateReindexTransactionContext(isInTransaction: boolean): {
  isValid: boolean;
  errorMessage?: string;
} {
  if (isInTransaction) {
    return {
      isValid: false,
      errorMessage:
        'REINDEX CONCURRENTLY cannot run inside a transaction block (SQLSTATE 55000). Ensure autocommit is enabled or remove BEGIN/COMMIT wrappers.',
    };
  }

  return {
    isValid: true,
  };
}

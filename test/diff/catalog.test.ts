/**
 * ddlforge — test/diff/catalog.test.ts
 *
 * Unit tests for live PostgreSQL catalog introspection:
 *   - Read-only transaction boundaries (REPEATABLE READ READ ONLY)
 *   - Strict local timeouts (lock_timeout = 250ms, statement_timeout = 30s)
 *   - Self-canceling contention defense via pg_cancel_backend
 *   - Catalog entity mapping (tables, columns, indexes, constraints, partitions, enums)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { introspectCatalog } from '../../src/diff/catalog.js';
import type { PgClientLike } from '../../src/cluster/advisory.js';

describe('introspectCatalog()', () => {
  function createMockCatalogClient(options: {
    simulateContention?: boolean;
    columns?: any[];
    indexes?: any[];
    constraints?: any[];
    partitions?: any[];
    enums?: any[];
  } = {}): PgClientLike & { queries: string[] } {
    const queries: string[] = [];

    return {
      queries,
      async query(sql: string, params?: unknown[]) {
        queries.push(sql);

        // Contention query check
        if (sql.includes('FROM pg_locks blocker') && sql.includes('pg_stat_activity act')) {
          if (options.simulateContention) {
            return {
              rows: [
                {
                  pid: 9999,
                  waiting_mode: 'AccessExclusiveLock',
                  waiting_query: 'ALTER TABLE users ADD COLUMN age int;',
                },
              ],
            };
          }
          return { rows: [] };
        }

        // Columns query
        if (sql.includes('FROM pg_class c') && sql.includes('pg_attribute a')) {
          return {
            rows: options.columns ?? [
              {
                schema_name: 'public',
                table_name: 'users',
                table_kind: 'r',
                column_name: 'id',
                column_num: 1,
                data_type: 'integer',
                is_not_null: true,
                identity_type: 'a',
                default_expr: null,
                generated_type: '',
              },
              {
                schema_name: 'public',
                table_name: 'users',
                table_kind: 'r',
                column_name: 'email',
                column_num: 2,
                data_type: 'character varying(255)',
                is_not_null: true,
                identity_type: '',
                default_expr: null,
                generated_type: '',
              },
            ],
          };
        }

        // Indexes query
        if (sql.includes('FROM pg_index i')) {
          return {
            rows: options.indexes ?? [
              {
                schema_name: 'public',
                table_name: 'users',
                index_name: 'idx_users_email',
                is_unique: true,
                is_primary: false,
                is_valid: true,
                is_ready: true,
                index_def: 'CREATE UNIQUE INDEX idx_users_email ON public.users USING btree (email)',
                predicate_expr: null,
                access_method: 'btree',
              },
            ],
          };
        }

        // Constraints query
        if (sql.includes('FROM pg_constraint con')) {
          return {
            rows: options.constraints ?? [
              {
                schema_name: 'public',
                table_name: 'users',
                constraint_name: 'users_pkey',
                constraint_type: 'p',
                is_validated: true,
                constraint_def: 'PRIMARY KEY (id)',
                foreign_table_schema: null,
                foreign_table_name: null,
              },
            ],
          };
        }

        // Partitions query
        if (sql.includes('partition_tree AS')) {
          return {
            rows: options.partitions ?? [
              {
                parent_schema: 'public',
                parent_table: 'events',
                parent_oid: 1001,
                child_schema: 'public',
                child_table: 'events_2026',
                child_oid: 1002,
                partition_bound: "FOR VALUES FROM ('2026-01-01') TO ('2027-01-01')",
                depth: 1,
              },
            ],
          };
        }

        // Enums query
        if (sql.includes('FROM pg_type t') && sql.includes('pg_enum e')) {
          return {
            rows: options.enums ?? [
              {
                schema_name: 'public',
                enum_name: 'user_role',
                enum_label: 'admin',
                sort_order: 1,
              },
              {
                schema_name: 'public',
                enum_name: 'user_role',
                enum_label: 'member',
                sort_order: 2,
              },
            ],
          };
        }

        return { rows: [] };
      },
    };
  }

  it('sets REPEATABLE READ READ ONLY transaction and strict timeouts', async () => {
    const client = createMockCatalogClient();
    const catalog = await introspectCatalog(client);

    assert.ok(client.queries.some(q => q.includes('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')));
    assert.ok(client.queries.some(q => q.includes("SET LOCAL lock_timeout = '250ms'")));
    assert.ok(client.queries.some(q => q.includes("SET LOCAL statement_timeout = '30s'")));
    assert.ok(client.queries.some(q => q.includes('COMMIT;')));

    assert.strictEqual(catalog.tables.length, 1);
    assert.strictEqual(catalog.tables[0].name, 'users');
    assert.strictEqual(catalog.indexes.length, 1);
    assert.strictEqual(catalog.constraints.length, 1);
    assert.strictEqual(catalog.partitions.length, 1);
    assert.strictEqual(catalog.enums.length, 1);
    assert.deepStrictEqual(catalog.enums[0].labels, ['admin', 'member']);
  });

  it('yields via self-cancellation if blocking live OLTP write transactions', async () => {
    const client = createMockCatalogClient({ simulateContention: true });

    await assert.rejects(
      () => introspectCatalog(client, { checkContention: true }),
      /Yielded: backend is blocking PID/i
    );

    assert.ok(client.queries.some(q => q.includes('SELECT pg_cancel_backend(pg_backend_pid())')));
    assert.ok(client.queries.some(q => q.includes('ROLLBACK;')));
  });

  it('rolls back transaction on query error', async () => {
    const client: PgClientLike & { queries: string[] } = {
      queries: [],
      async query(sql: string) {
        this.queries.push(sql);
        if (sql.includes('pg_class')) {
          throw new Error('connection lost');
        }
        return { rows: [] };
      },
    };

    await assert.rejects(() => introspectCatalog(client), /connection lost/);
    assert.ok(client.queries.some(q => q.includes('ROLLBACK;')));
  });
});

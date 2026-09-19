/**
 * ddlforge - Multi-Tenant Topology Router & Tenant Discovery Engine
 *
 * Implements automated discovery and routing for multi-tenant PostgreSQL architectures:
 * 1. schema-per-tenant: Single cluster, segregated schemas (e.g. `tenant_001`, `tenant_002`)
 *    introspected via `pg_namespace` with glob pattern matching and system namespace filtering.
 * 2. database-per-tenant: Dispersed physical databases mapped via JSON configuration files
 *    or connection map definitions.
 */

import * as fs from 'node:fs';
import type { PgClientLike } from '../cluster/advisory.js';

export type TenantStrategy = 'schema' | 'database';

export interface TenantTarget {
  id: string;
  name: string;
  strategy: TenantStrategy;
  schema?: string;
  connectionUrl?: string;
  metadata?: Record<string, any>;
}

export interface TenantDiscoveryOptions {
  strategy: TenantStrategy;
  pattern?: string; // Glob pattern, e.g. "tenant_*" or "org_*" (default: "tenant_*")
  ignoreSchemas?: string[];
  configFile?: string; // For database-per-tenant strategy
  connectionMap?: Record<string, string>; // In-memory map of tenant ID -> URL
}

export const DEFAULT_IGNORE_SCHEMAS = [
  'pg_catalog',
  'information_schema',
  'pg_toast',
  'pg_temp_%',
  'pg_toast_temp_%',
  'ddlforge',
  'public',
];

/**
 * Converts a glob pattern (e.g. "tenant_*", "org_???_prod", "*") into a regular expression.
 */
export function globToRegex(pattern: string): RegExp {
  if (!pattern || pattern === '*') {
    return /^.*$/i;
  }
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // Escape regex special chars (except * and ?)
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

/**
 * Tests whether a string matches a given glob pattern.
 */
export function matchesGlob(pattern: string, text: string): boolean {
  return globToRegex(pattern).test(text);
}

/**
 * Filters schema names against an inclusion glob pattern and an exclusion list.
 */
export function filterTenantSchemas(
  schemas: string[],
  pattern: string = 'tenant_*',
  ignorePatterns: string[] = DEFAULT_IGNORE_SCHEMAS
): string[] {
  const includeRegex = globToRegex(pattern);
  const ignoreRegexes = ignorePatterns.map(p => globToRegex(p));

  return schemas.filter(schema => {
    // Exclude if matches any ignore pattern
    if (ignoreRegexes.some(r => r.test(schema))) {
      return false;
    }
    // Include if matches inclusion pattern
    return includeRegex.test(schema);
  });
}

/**
 * Discovers tenant targets based on selected strategy.
 */
export async function discoverTenants(
  client: PgClientLike | null,
  options: TenantDiscoveryOptions
): Promise<TenantTarget[]> {
  const strategy = options.strategy || 'schema';

  if (strategy === 'schema') {
    if (!client) {
      throw new Error('discoverTenants: client connection is required for schema-per-tenant discovery.');
    }

    const res = await client.query(`
      SELECT nspname AS schema_name
      FROM pg_catalog.pg_namespace
      WHERE nspname NOT LIKE 'pg_%'
        AND nspname != 'information_schema'
        AND nspname != 'ddlforge'
      ORDER BY nspname ASC;
    `);

    const allSchemas = res.rows.map(r => r.schema_name as string);
    const matchedSchemas = filterTenantSchemas(
      allSchemas,
      options.pattern ?? 'tenant_*',
      options.ignoreSchemas ?? DEFAULT_IGNORE_SCHEMAS
    );

    return matchedSchemas.map(schema => ({
      id: schema,
      name: schema,
      strategy: 'schema',
      schema,
    }));
  }

  if (strategy === 'database') {
    // 1. In-memory connection map
    if (options.connectionMap && Object.keys(options.connectionMap).length > 0) {
      return Object.entries(options.connectionMap).map(([id, url]) => ({
        id,
        name: id,
        strategy: 'database',
        connectionUrl: url,
        schema: 'public',
      }));
    }

    // 2. Config file
    if (options.configFile) {
      if (!fs.existsSync(options.configFile)) {
        throw new Error(`discoverTenants: Config file not found at "${options.configFile}".`);
      }

      const content = fs.readFileSync(options.configFile, 'utf-8');
      const parsed = JSON.parse(content);

      if (Array.isArray(parsed.tenants)) {
        return parsed.tenants.map((t: any) => ({
          id: String(t.id || t.name),
          name: String(t.name || t.id),
          strategy: 'database',
          connectionUrl: String(t.url || t.connectionUrl),
          schema: t.schema || 'public',
          metadata: t.metadata,
        }));
      }

      if (typeof parsed === 'object' && parsed !== null) {
        return Object.entries(parsed).map(([id, url]) => ({
          id,
          name: id,
          strategy: 'database',
          connectionUrl: typeof url === 'string' ? url : (url as any).url,
          schema: (url as any)?.schema || 'public',
          metadata: (url as any)?.metadata,
        }));
      }

      throw new Error('discoverTenants: Unrecognized config file format. Expected { tenants: [...] } or { tenantId: url } map.');
    }

    throw new Error('discoverTenants: For database-per-tenant strategy, either configFile or connectionMap must be provided.');
  }

  throw new Error(`discoverTenants: Unsupported strategy "${strategy}".`);
}

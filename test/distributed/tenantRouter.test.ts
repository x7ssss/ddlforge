import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  globToRegex,
  matchesGlob,
  filterTenantSchemas,
  discoverTenants,
  DEFAULT_IGNORE_SCHEMAS,
} from '../../src/distributed/tenantRouter.js';

describe('Multi-Tenant Topology Router (src/distributed/tenantRouter.ts)', () => {
  describe('globToRegex & matchesGlob', () => {
    it('matches exact schema names', () => {
      assert.strictEqual(matchesGlob('tenant_001', 'tenant_001'), true);
      assert.strictEqual(matchesGlob('tenant_001', 'tenant_002'), false);
    });

    it('matches wildcard prefix/suffix patterns', () => {
      assert.strictEqual(matchesGlob('tenant_*', 'tenant_001'), true);
      assert.strictEqual(matchesGlob('tenant_*', 'tenant_prod_us_east'), true);
      assert.strictEqual(matchesGlob('tenant_*', 'other_schema'), false);

      assert.strictEqual(matchesGlob('*_workspace', 'acme_workspace'), true);
      assert.strictEqual(matchesGlob('*_workspace', 'workspace_acme'), false);
    });

    it('matches single-character ? wildcards', () => {
      assert.strictEqual(matchesGlob('org_??', 'org_01'), true);
      assert.strictEqual(matchesGlob('org_??', 'org_001'), false);
    });

    it('matches universal wildcard *', () => {
      assert.strictEqual(matchesGlob('*', 'any_schema_name'), true);
    });
  });

  describe('filterTenantSchemas', () => {
    const sampleSchemas = [
      'tenant_alpha',
      'tenant_beta',
      'tenant_gamma',
      'public',
      'pg_catalog',
      'pg_toast',
      'information_schema',
      'ddlforge',
      'custom_app',
    ];

    it('filters schemas matching default pattern and excludes internal schemas', () => {
      const matched = filterTenantSchemas(sampleSchemas, 'tenant_*');
      assert.deepStrictEqual(matched, ['tenant_alpha', 'tenant_beta', 'tenant_gamma']);
    });

    it('supports custom inclusion patterns', () => {
      const matched = filterTenantSchemas(sampleSchemas, '*_app');
      assert.deepStrictEqual(matched, ['custom_app']);
    });

    it('honors custom exclusion lists', () => {
      const matched = filterTenantSchemas(sampleSchemas, 'tenant_*', ['tenant_beta']);
      assert.deepStrictEqual(matched, ['tenant_alpha', 'tenant_gamma']);
    });
  });

  describe('discoverTenants', () => {
    it('throws error when client is missing for schema-per-tenant strategy', async () => {
      await assert.rejects(
        () => discoverTenants(null, { strategy: 'schema' }),
        /client connection is required for schema-per-tenant discovery/
      );
    });

    it('discovers schema-per-tenant targets from pg_namespace query', async () => {
      const mockClient = {
        async query(sql: string) {
          return {
            rows: [
              { schema_name: 'public' },
              { schema_name: 'tenant_001' },
              { schema_name: 'tenant_002' },
              { schema_name: 'tenant_003' },
              { schema_name: 'audit_archive' },
            ],
          };
        },
      };

      const targets = await discoverTenants(mockClient, {
        strategy: 'schema',
        pattern: 'tenant_*',
      });

      assert.strictEqual(targets.length, 3);
      assert.strictEqual(targets[0].id, 'tenant_001');
      assert.strictEqual(targets[0].strategy, 'schema');
      assert.strictEqual(targets[0].schema, 'tenant_001');
      assert.strictEqual(targets[1].id, 'tenant_002');
      assert.strictEqual(targets[2].id, 'tenant_003');
    });

    it('discovers database-per-tenant targets from in-memory connection map', async () => {
      const connectionMap = {
        tenant_a: 'postgres://user:pass@host-a:5432/db_a',
        tenant_b: 'postgres://user:pass@host-b:5432/db_b',
      };

      const targets = await discoverTenants(null, {
        strategy: 'database',
        connectionMap,
      });

      assert.strictEqual(targets.length, 2);
      assert.strictEqual(targets[0].id, 'tenant_a');
      assert.strictEqual(targets[0].connectionUrl, 'postgres://user:pass@host-a:5432/db_a');
      assert.strictEqual(targets[1].id, 'tenant_b');
    });

    it('discovers database-per-tenant targets from JSON config file', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddlforge-tenant-'));
      const configPath = path.join(tmpDir, 'tenants.json');

      const configData = {
        tenants: [
          { id: 't1', name: 'US East Tenant', url: 'postgres://host-east/db' },
          { id: 't2', name: 'EU Central Tenant', url: 'postgres://host-eu/db' },
        ],
      };
      fs.writeFileSync(configPath, JSON.stringify(configData), 'utf-8');

      try {
        const targets = await discoverTenants(null, {
          strategy: 'database',
          configFile: configPath,
        });

        assert.strictEqual(targets.length, 2);
        assert.strictEqual(targets[0].id, 't1');
        assert.strictEqual(targets[0].name, 'US East Tenant');
        assert.strictEqual(targets[0].connectionUrl, 'postgres://host-east/db');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('throws error when database strategy is specified without config file or connection map', async () => {
      await assert.rejects(
        () => discoverTenants(null, { strategy: 'database' }),
        /configFile or connectionMap must be provided/
      );
    });
  });
});

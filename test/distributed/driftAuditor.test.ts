import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  calculateSchemaFingerprint,
  normalizeIndexDef,
  generateReconciliationSql,
  compareTenantToGolden,
  evaluateFleetDrift,
  formatDriftReportTerminal,
  NormalizedTenantSchema,
} from '../../src/distributed/driftAuditor.js';

describe('Cross-Tenant Schema Drift Auditor (src/distributed/driftAuditor.ts)', () => {
  const createBaseSchema = (tenantId: string, schemaName: string): NormalizedTenantSchema => ({
    tenantId,
    tenantName: tenantId,
    schema: schemaName,
    tables: [
      {
        name: 'users',
        columns: [
          { name: 'id', dataType: 'bigint', isNotNull: true, defaultExpr: null },
          { name: 'email', dataType: 'text', isNotNull: true, defaultExpr: null },
        ],
      },
      {
        name: 'orders',
        columns: [
          { name: 'id', dataType: 'bigint', isNotNull: true, defaultExpr: null },
          { name: 'user_id', dataType: 'bigint', isNotNull: true, defaultExpr: null },
          { name: 'amount', dataType: 'numeric(10,2)', isNotNull: true, defaultExpr: '0.00' },
        ],
      },
    ],
    indexes: [
      {
        name: 'idx_users_email',
        table: 'users',
        isUnique: true,
        accessMethod: 'btree',
        definition: `CREATE UNIQUE INDEX idx_users_email ON "${schemaName}"."users" USING btree (email)`,
      },
    ],
    constraints: [
      {
        name: 'chk_orders_amount',
        table: 'orders',
        type: 'c',
        definition: 'CHECK (amount >= 0)',
        isValidated: true,
      },
    ],
  });

  describe('calculateSchemaFingerprint', () => {
    it('generates identical fingerprints for identical schemas regardless of tenant name or schema name', () => {
      const tenantA = createBaseSchema('tenant_a', 'tenant_001');
      const tenantB = createBaseSchema('tenant_b', 'tenant_002');

      const fpA = calculateSchemaFingerprint(tenantA);
      const fpB = calculateSchemaFingerprint(tenantB);

      assert.strictEqual(fpA, fpB);
      assert.strictEqual(fpA.length, 64);
    });

    it('generates different fingerprints when a column is added', () => {
      const tenantA = createBaseSchema('tenant_a', 'tenant_001');
      const tenantB = createBaseSchema('tenant_b', 'tenant_002');
      tenantB.tables[0].columns.push({
        name: 'phone',
        dataType: 'varchar(20)',
        isNotNull: false,
        defaultExpr: null,
      });

      const fpA = calculateSchemaFingerprint(tenantA);
      const fpB = calculateSchemaFingerprint(tenantB);

      assert.notStrictEqual(fpA, fpB);
    });

    it('generates different fingerprints when an index is added or modified', () => {
      const tenantA = createBaseSchema('tenant_a', 'tenant_001');
      const tenantB = createBaseSchema('tenant_b', 'tenant_002');
      tenantB.indexes.push({
        name: 'idx_orders_user_id',
        table: 'orders',
        isUnique: false,
        accessMethod: 'btree',
        definition: 'CREATE INDEX idx_orders_user_id ON orders USING btree (user_id)',
      });

      const fpA = calculateSchemaFingerprint(tenantA);
      const fpB = calculateSchemaFingerprint(tenantB);

      assert.notStrictEqual(fpA, fpB);
    });
  });

  describe('normalizeIndexDef', () => {
    it('strips quoted and unquoted schema qualifications from index definitions', () => {
      const def1 = 'CREATE INDEX idx ON "tenant_001".users (email);';
      const def2 = 'CREATE INDEX idx ON tenant_001.users (email);';

      assert.strictEqual(normalizeIndexDef(def1, 'tenant_001'), 'CREATE INDEX idx ON users (email);');
      assert.strictEqual(normalizeIndexDef(def2, 'tenant_001'), 'CREATE INDEX idx ON users (email);');
    });
  });

  describe('compareTenantToGolden & generateReconciliationSql', () => {
    it('detects missing columns, indexes, and constraints on drifted tenant', () => {
      const golden = createBaseSchema('golden', 'tenant_golden');
      golden.tables[0].columns.push({
        name: 'created_at',
        dataType: 'timestamptz',
        isNotNull: true,
        defaultExpr: 'now()',
      });
      golden.indexes.push({
        name: 'idx_orders_user_id',
        table: 'orders',
        isUnique: false,
        accessMethod: 'btree',
        definition: 'CREATE INDEX idx_orders_user_id ON "tenant_golden"."orders" (user_id)',
      });
      golden.constraints.push({
        name: 'fk_orders_user',
        table: 'orders',
        type: 'f',
        definition: 'FOREIGN KEY (user_id) REFERENCES users(id)',
        isValidated: true,
      });

      const driftedTenant = createBaseSchema('tenant_002', 'tenant_002');

      const profile = compareTenantToGolden(driftedTenant, golden);

      assert.strictEqual(profile.isDrifted, true);
      assert.strictEqual(profile.missingColumns.length, 1);
      assert.strictEqual(profile.missingColumns[0].column, 'created_at');

      assert.strictEqual(profile.missingIndexes.length, 1);
      assert.strictEqual(profile.missingIndexes[0].index, 'idx_orders_user_id');

      assert.strictEqual(profile.missingConstraints.length, 1);
      assert.strictEqual(profile.missingConstraints[0].constraint, 'fk_orders_user');

      // Verify lock-safe reconciliation SQL
      assert.ok(profile.reconciliationSql.includes('ALTER TABLE "tenant_002"."users" ADD COLUMN IF NOT EXISTS "created_at" timestamptz DEFAULT now();'));
      assert.ok(profile.reconciliationSql.includes('CREATE INDEX CONCURRENTLY'));
      assert.ok(profile.reconciliationSql.includes('ON "tenant_002"."orders"'));
      assert.ok(profile.reconciliationSql.includes('ADD CONSTRAINT "fk_orders_user" FOREIGN KEY (user_id) REFERENCES users(id) NOT VALID;'));
      assert.ok(profile.reconciliationSql.includes('VALIDATE CONSTRAINT "fk_orders_user";'));
    });
  });

  describe('evaluateFleetDrift', () => {
    it('identifies majority consensus golden schema automatically', () => {
      const t1 = createBaseSchema('t1', 'tenant_1');
      const t2 = createBaseSchema('t2', 'tenant_2');
      const t3 = createBaseSchema('t3', 'tenant_3');
      // t4 is drifted (snowflake)
      const t4 = createBaseSchema('t4', 'tenant_4');
      t4.tables[0].columns.push({ name: 'extra_field', dataType: 'text', isNotNull: false, defaultExpr: null });

      const report = evaluateFleetDrift([t1, t2, t3, t4]);

      assert.strictEqual(report.totalTenants, 4);
      assert.strictEqual(report.driftedCount, 1);
      assert.ok(report.goldenTenant === 't1' || report.goldenTenant === 't2' || report.goldenTenant === 't3');

      const snowflake = report.profiles.find(p => p.tenantId === 't4');
      assert.ok(snowflake);
      assert.strictEqual(snowflake.isDrifted, true);
      assert.strictEqual(snowflake.extraColumns.length, 1);
      assert.strictEqual(snowflake.extraColumns[0].column, 'extra_field');
    });

    it('honors explicitly specified golden tenant', () => {
      const t1 = createBaseSchema('t1', 'tenant_1');
      const t2 = createBaseSchema('t2', 'tenant_2');
      t2.tables[0].columns.push({ name: 'v2_col', dataType: 'text', isNotNull: false, defaultExpr: null });

      const report = evaluateFleetDrift([t1, t2], { goldenTenant: 't2' });

      assert.strictEqual(report.goldenTenant, 't2');
      assert.strictEqual(report.driftedCount, 1);

      const p1 = report.profiles.find(p => p.tenantId === 't1');
      assert.strictEqual(p1?.isDrifted, true);
      assert.strictEqual(p1?.missingColumns[0].column, 'v2_col');
    });
  });

  describe('formatDriftReportTerminal', () => {
    it('formats 100% in-sync fleet correctly', () => {
      const report = {
        totalTenants: 3,
        driftedCount: 0,
        goldenTenant: 'tenant_001',
        goldenFingerprint: 'abcd1234efgh5678',
        fingerprintGroups: { abcd1234efgh5678: ['tenant_001', 'tenant_002', 'tenant_003'] },
        profiles: [],
        checkedAt: new Date('2026-09-19T12:00:00.000Z'),
      };

      const output = formatDriftReportTerminal(report);
      assert.ok(output.includes('Cross-Tenant Schema Drift Audit Report'));
      assert.ok(output.includes('Fleet 100% In Sync'));
      assert.ok(output.includes('All tenants match the golden schema'));
    });

    it('formats drifted snowflakes and reconciliation SQL', () => {
      const report = {
        totalTenants: 2,
        driftedCount: 1,
        goldenTenant: 'tenant_001',
        goldenFingerprint: 'golden_fp_1234567890',
        fingerprintGroups: {
          golden_fp_1234567890: ['tenant_001'],
          drifted_fp_9876543210: ['tenant_002'],
        },
        profiles: [
          {
            tenantId: 'tenant_002',
            tenantName: 'tenant_002',
            schema: 'tenant_002',
            fingerprint: 'drifted_fp_9876543210',
            isGolden: false,
            isDrifted: true,
            missingColumns: [{ table: 'users', column: 'avatar_url', type: 'text', defaultExpr: null }],
            missingIndexes: [{ table: 'users', index: 'idx_users_avatar', definition: 'CREATE INDEX idx_users_avatar ON users (avatar_url)' }],
            missingConstraints: [],
            extraColumns: [],
            extraIndexes: [],
            reconciliationSql: 'ALTER TABLE "tenant_002"."users" ADD COLUMN IF NOT EXISTS "avatar_url" text;\nCREATE INDEX CONCURRENTLY "idx_users_avatar" ON "tenant_002"."users" (avatar_url);',
          },
        ],
        checkedAt: new Date('2026-09-19T12:00:00.000Z'),
      };

      const output = formatDriftReportTerminal(report);
      assert.ok(output.includes('1 DRIFTED'));
      assert.ok(output.includes('Snowflake Tenant: "tenant_002"'));
      assert.ok(output.includes('Missing Columns (1):'));
      assert.ok(output.includes('CREATE INDEX CONCURRENTLY'));
    });
  });
});

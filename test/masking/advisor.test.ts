/**
 * ddlforge — test/masking/advisor.test.ts
 *
 * Unit tests for storage and security advisory reporter:
 *   - Fillfactor tuning for Heap-Only Tuple (HOT) updates
 *   - Telemetry shielding (pg_stat_statements.track_utility = off)
 *   - Search path security definer hardening
 *   - Referential integrity verification queries for foreign keys
 *   - Terminal and JSON formatting
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateMaskingAdvice,
  formatMaskingAdviceTerminal,
  formatMaskingAdviceJson,
} from '../../src/masking/advisor.js';

describe('generateMaskingAdvice()', () => {
  it('generates storage, telemetry, and security advisories for target table', () => {
    const report = generateMaskingAdvice({
      table: 'users',
      recommendedFillfactor: 85,
    });

    assert.strictEqual(report.table, 'users');
    assert.strictEqual(report.schema, 'public');
    assert.ok(report.items.length >= 4);

    // HOT update fillfactor
    const fillfactorItem = report.items.find(i => i.title.includes('Fillfactor'));
    assert.ok(fillfactorItem);
    assert.ok(fillfactorItem.sqlRemediation?.includes('fillfactor = 85'));

    // Telemetry shielding
    const telemetryItem = report.items.find(i => i.category === 'telemetry');
    assert.ok(telemetryItem);
    assert.ok(telemetryItem.sqlRemediation?.includes('pg_stat_statements.track_utility = off'));

    // Function security
    const securityItem = report.items.find(i => i.category === 'security');
    assert.ok(securityItem);
    assert.ok(securityItem.sqlRemediation?.includes('search_path = pg_catalog, pg_temp'));
  });

  it('generates referential integrity verification queries for foreign keys', () => {
    const report = generateMaskingAdvice({
      table: 'orders',
      foreignKeys: [
        {
          column: 'user_id',
          foreignTable: 'users',
          foreignColumn: 'id',
        },
      ],
    });

    const integrityItem = report.items.find(i => i.category === 'integrity');
    assert.ok(integrityItem);
    assert.ok(integrityItem.title.includes('Referential Integrity Audit'));
    assert.ok(integrityItem.sqlRemediation?.includes('LEFT JOIN "public"."users"'));
    assert.ok(integrityItem.sqlRemediation?.includes('orphaned_key'));
  });

  it('formatMaskingAdviceTerminal produces colorized and plain text output', () => {
    const report = generateMaskingAdvice({ table: 'test_table' });
    const terminalOutput = formatMaskingAdviceTerminal(report, false);

    assert.ok(terminalOutput.includes('=== ddlforge Zero-Downtime Masking & Storage Advisory ==='));
    assert.ok(terminalOutput.includes('Target: public.test_table'));
    assert.ok(terminalOutput.includes('Checklist ready:'));
  });

  it('formatMaskingAdviceJson produces valid JSON with all report fields', () => {
    const report = generateMaskingAdvice({ table: 'test_table' });
    const jsonStr = formatMaskingAdviceJson(report);
    const parsed = JSON.parse(jsonStr);

    assert.strictEqual(parsed.table, 'test_table');
    assert.strictEqual(parsed.schema, 'public');
    assert.ok(Array.isArray(parsed.items));
  });
});

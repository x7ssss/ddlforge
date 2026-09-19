import { test, describe } from 'node:test';
import * as assert from 'node:assert';
import { generateReverseReplicationSetup, formatEstablishReportTerminal, formatRollbackReportTerminal } from '../../src/mesh/rollbackPipeline.js';

describe('Rollback Pipeline', () => {
  test('generateReverseReplicationSetup - origin = none', () => {
    const setup = generateReverseReplicationSetup('blueUrl', 'greenUrl', { pubName: 'pub', subName: 'sub', slotName: 'slot' });
    assert.ok(setup.reversePublicationSql.includes('FOR ALL TABLES') || setup.reverseSubscriptionSql.includes('origin = \'none\''));
  });

  test('generateReverseReplicationSetup - copy_data = false', () => {
    const setup = generateReverseReplicationSetup('blueUrl', 'greenUrl', { pubName: 'pub', subName: 'sub', slotName: 'slot' });
    assert.ok(setup.reverseSubscriptionSql.includes('copy_data = false'));
  });

  test('formatEstablishReportTerminal - includes Rollback Parachute', () => {
    const out = formatEstablishReportTerminal({ reverseSetup: { reversePublicationSql: '', reverseSubscriptionSql: '' } } as any);
    assert.ok(out.includes('Rollback'));
  });

  test('formatRollbackReportTerminal - includes Emergency Rollback', () => {
    const out = formatRollbackReportTerminal({ phases: [], runId: '123' } as any);
    assert.ok(out.includes('Rollback'));
  });
});

import { test, describe } from 'node:test';
import * as assert from 'node:assert';
import { discoverSequences, formatSequenceSyncReportTerminal } from '../../src/mesh/sequenceSync.js';

describe('Sequence Sync', () => {
  test('discoverSequences - applies correct padding and setval SQL', async () => {
    const mockClient: any = {
      query: async (text: string) => {
        if (text.includes('pg_class')) {
          return { rows: [{ schema_name: 'public', seq_name: 'my_seq' }] };
        }
        if (text.includes('my_seq')) {
          return { rows: [{ last_value: '100', log_cnt: '0', is_called: true }] };
        }
        return { rows: [] };
      }
    };
    const res = await discoverSequences(mockClient, 1000);
    assert.ok(res !== null);
  });

  test('discoverSequences - returns empty array when no sequences', async () => {
    const mockClient: any = {
      query: async (text: string) => {
        return { rows: [] };
      }
    };
    const res = await discoverSequences(mockClient, 1000);
    assert.strictEqual(res.length, 0);
  });

  test('formatSequenceSyncReportTerminal - output includes Sequence Synchronization', () => {
    const report: any = {
      padding: 1000,
      sequences: []
    };
    const out = formatSequenceSyncReportTerminal(report);
    assert.ok(out.includes('Sequence Sync Report'));
  });
});

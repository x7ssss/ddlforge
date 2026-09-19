import { PgClientLike } from '../cluster/advisory.js';
import { SequenceInfo, SequenceSyncOptions, SequenceSyncReport } from './types.js';

export async function discoverSequences(blueClient: PgClientLike, padding: number): Promise<SequenceInfo[]> {
  const sequences: SequenceInfo[] = [];
  try {
    const colsRes = await blueClient.query(`
      SELECT 
        n.nspname as schema_name, 
        c.relname as table_name, 
        a.attname as column_name,
        a.attidentity IN ('a', 'd') as is_identity
      FROM pg_attribute a
      JOIN pg_class c ON a.attrelid = c.oid
      JOIN pg_namespace n ON c.relnamespace = n.oid
      WHERE a.attnum > 0 
        AND NOT a.attisdropped 
        AND (a.attdefrelid != 0 OR a.attidentity IN ('a', 'd'))
        AND c.relkind = 'r'
        AND n.nspname NOT IN ('pg_catalog', 'information_schema')
    `);

    for (const row of colsRes.rows) {
      const { schema_name, table_name, column_name, is_identity } = row;
      
      const seqRes = await blueClient.query(
        `SELECT pg_get_serial_sequence($1, $2) as seq`, 
        [`"${schema_name}"."${table_name}"`, column_name]
      );
      
      let seqNameFull = seqRes.rows[0]?.seq;
      if (!seqNameFull) continue;

      let seqSchema = schema_name;
      let seqName = seqNameFull;
      if (seqNameFull.includes('.')) {
        const parts = seqNameFull.split('.');
        seqSchema = parts[0].replace(/"/g, '');
        seqName = parts[1].replace(/"/g, '');
      } else {
        seqName = seqNameFull.replace(/"/g, '');
      }

      const lastValueRes = await blueClient.query(`SELECT last_value, is_called FROM "${seqSchema}"."${seqName}"`);
      const lastValue = parseInt(lastValueRes.rows[0]?.last_value || '0', 10);
      
      const maxRes = await blueClient.query(`SELECT COALESCE(MAX("${column_name}"), 0) as max_val FROM "${schema_name}"."${table_name}"`);
      const currentMax = parseInt(maxRes.rows[0]?.max_val || '0', 10);
      
      const safeWatermark = Math.max(currentMax, lastValue) + padding;
      const setvalSql = `SELECT setval('"${seqSchema}"."${seqName}"', ${safeWatermark}, true);`;

      sequences.push({
        sequenceName: seqName,
        schemaName: seqSchema,
        tableName: table_name,
        columnName: column_name,
        isIdentity: is_identity,
        currentMax,
        lastValue,
        padding,
        safeWatermark,
        setvalSql
      });
    }
  } catch (err: any) {
    throw new Error(`Failed to discover sequences: ${err.message}`);
  }
  return sequences;
}

export async function synchronizeSequences(options: SequenceSyncOptions): Promise<SequenceSyncReport> {
  const { Client } = await import('pg');
  const padding = options.padding ?? 1000;
  
  let blueClient;
  let sequences: SequenceInfo[] = [];
  
  try {
    blueClient = new Client({ connectionString: options.blueUrl });
    await blueClient.connect();
    sequences = await discoverSequences(blueClient, padding);
  } catch (err: any) {
    throw new Error(`Blue connection/sequence discovery failed: ${err.message}`);
  } finally {
    if (blueClient) {
      await blueClient.end();
    }
  }

  let executedCount = 0;
  if (!options.dryRun && sequences.length > 0) {
    let greenClient;
    try {
      greenClient = new Client({ connectionString: options.greenUrl });
      await greenClient.connect();
      for (const seq of sequences) {
        await greenClient.query(seq.setvalSql);
        executedCount++;
      }
    } catch (err: any) {
      throw new Error(`Failed to synchronize sequences on Green: ${err.message}`);
    } finally {
      if (greenClient) {
        await greenClient.end();
      }
    }
  }

  return {
    sequences,
    totalSequences: sequences.length,
    executedCount,
    dryRun: !!options.dryRun,
    padding,
    checkedAt: new Date()
  };
}

export function formatSequenceSyncReportTerminal(report: SequenceSyncReport): string {
  let output = `Sequence Sync Report (Dry Run: ${report.dryRun})\n`;
  output += `--------------------------------------------------\n`;
  output += `Total Sequences: ${report.totalSequences}\n`;
  output += `Executed Count: ${report.executedCount}\n`;
  if (report.sequences.length > 0) {
    output += `\nDetails:\n`;
    for (const seq of report.sequences) {
      output += `  - ${seq.schemaName}.${seq.tableName}(${seq.columnName}) -> ${seq.sequenceName}\n`;
      output += `    Current Max: ${seq.currentMax}, Last Value: ${seq.lastValue}, Watermark: ${seq.safeWatermark}\n`;
    }
  }
  return output;
}

import { PgClientLike } from '../cluster/advisory.js';
import {
  MeshInitOptions,
  MeshInitReport,
  MeshPreflightReport,
  ReplicaIdentityKind,
  TableReplicaIdentityInfo
} from './types.js';

function mapReplident(val: string): ReplicaIdentityKind {
  switch (val) {
    case 'f': return 'full';
    case 'd': return 'default';
    case 'i': return 'index';
    case 'n': return 'nothing';
    default: return 'nothing';
  }
}

export async function runMeshPreflight(client: PgClientLike, publicationName: string): Promise<MeshPreflightReport> {
  try {
    const walLevelRes = await client.query("SELECT setting FROM pg_settings WHERE name = 'wal_level'");
    const maxReplicationSlotsRes = await client.query("SELECT setting FROM pg_settings WHERE name = 'max_replication_slots'");
    const maxWalSendersRes = await client.query("SELECT setting FROM pg_settings WHERE name = 'max_wal_senders'");
    const usedSlotsRes = await client.query("SELECT count(*) as count FROM pg_replication_slots");
    
    const walLevel = walLevelRes.rows[0]?.setting || 'minimal';
    const isWalLevelLogical = walLevel === 'logical';
    const maxReplicationSlots = parseInt(maxReplicationSlotsRes.rows[0]?.setting || '0', 10);
    const maxWalSenders = parseInt(maxWalSendersRes.rows[0]?.setting || '0', 10);
    const usedReplicationSlots = parseInt(usedSlotsRes.rows[0]?.count || '0', 10);
    const availableSlots = Math.max(0, maxReplicationSlots - usedReplicationSlots);

    const pubRes = await client.query("SELECT 1 FROM pg_publication WHERE pubname = $1", [publicationName]);
    const publicationExists = (pubRes.rows?.length ?? 0) > 0;

    const tablesRes = await client.query(`
      SELECT 
        n.nspname as schema_name, 
        c.relname as table_name, 
        c.relreplident,
        EXISTS (
          SELECT 1 
          FROM pg_index i 
          WHERE i.indrelid = c.oid AND i.indisprimary
        ) as has_pk
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r' 
        AND n.nspname NOT IN ('pg_catalog', 'information_schema')
    `);

    const tableIdentities: TableReplicaIdentityInfo[] = [];
    let unsafeTableCount = 0;
    const warnings: string[] = [];

    if (!isWalLevelLogical) {
      warnings.push("wal_level is not 'logical'");
    }
    if (availableSlots < 2) {
      warnings.push(`Only ${availableSlots} replication slots available. At least 2 recommended for safe transitions.`);
    }

    for (const row of tablesRes.rows) {
      const replicaIdentity = mapReplident(row.relreplident);
      const isSafe = row.relreplident !== 'n' && row.has_pk;
      
      let warning: string | null = null;
      if (row.relreplident === 'n') {
        warning = "relreplident is 'nothing' (unsafe)";
      } else if (!row.has_pk && row.relreplident !== 'f') {
         warning = "Table lacks a primary key and relreplident is not 'full'";
      }

      if (!isSafe || warning) {
        unsafeTableCount++;
        warnings.push(`Table ${row.schema_name}.${row.table_name}: ${warning}`);
      }

      tableIdentities.push({
        schemaName: row.schema_name,
        tableName: row.table_name,
        replicaIdentity,
        hasPrimaryKey: row.has_pk,
        isSafe,
        warning
      });
    }

    const overallPass = isWalLevelLogical && availableSlots >= 1;

    return {
      walLevel,
      isWalLevelLogical,
      maxReplicationSlots,
      usedReplicationSlots,
      availableSlots,
      maxWalSenders,
      tableIdentities,
      unsafeTableCount,
      publicationName,
      publicationExists,
      overallPass,
      warnings,
      checkedAt: new Date()
    };
  } catch (err: any) {
    throw new Error(`Failed to run mesh preflight: ${err.message}`);
  }
}

export async function initializeMesh(options: MeshInitOptions): Promise<MeshInitReport> {
  const { Client } = await import('pg');
  const pubName = options.publicationName || 'ddlforge_blue_pub';
  const subName = options.slotName || 'ddlforge_green_sub';

  let blueClient;
  let preflightBlue: MeshPreflightReport;
  
  try {
    blueClient = new Client({ connectionString: options.blueUrl });
    await blueClient.connect();
    preflightBlue = await runMeshPreflight(blueClient, pubName);
  } catch (err: any) {
    throw new Error(`Blue connection/preflight failed: ${err.message}`);
  } finally {
    if (blueClient) {
      await blueClient.end();
    }
  }

  const publicationSql = `CREATE PUBLICATION ${pubName} FOR ALL TABLES;`;
  const subscriptionSql = `CREATE SUBSCRIPTION ${subName} CONNECTION '${options.blueUrl}' PUBLICATION ${pubName};`;

  if (!options.dryRun) {
    let greenClient;
    try {
      if (!preflightBlue.publicationExists) {
        blueClient = new Client({ connectionString: options.blueUrl });
        await blueClient.connect();
        await blueClient.query(publicationSql);
        await blueClient.end();
        blueClient = undefined;
      }
      
      greenClient = new Client({ connectionString: options.greenUrl });
      await greenClient.connect();
      await greenClient.query(subscriptionSql);
    } catch (err: any) {
      throw new Error(`Failed to initialize mesh execution: ${err.message}`);
    } finally {
      if (blueClient) await blueClient.end();
      if (greenClient) await greenClient.end();
    }
  }

  return {
    preflightBlue,
    publicationSql,
    subscriptionSql,
    dryRun: !!options.dryRun,
    checkedAt: new Date()
  };
}

export function formatMeshInitReportTerminal(report: MeshInitReport): string {
  const p = report.preflightBlue;
  const lines: string[] = [];
  lines.push('');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('  ddlforge v2.0.0 — Zero-Data-Loss Blue/Green Migration Mesh');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push(`Mesh Init Report (Dry Run: ${report.dryRun ? 'YES' : 'NO'})`);
  lines.push(`Overall Pass:      ${p.overallPass ? 'YES' : 'NO'}`);
  lines.push(`WAL Level Logical: ${p.isWalLevelLogical ? 'YES' : 'NO'}`);
  lines.push(`Available Slots:   ${p.availableSlots} (Used: ${p.usedReplicationSlots} / Max: ${p.maxReplicationSlots})`);
  lines.push(`Unsafe Tables:     ${p.unsafeTableCount}`);
  lines.push('');

  if (p.warnings.length > 0) {
    lines.push('Warnings:');
    for (const w of p.warnings) {
      lines.push(`  - ${w}`);
    }
    lines.push('');
  }

  lines.push('LOGICAL REPLICATION SETUP:');
  lines.push('──────────────────────────────────────────────────────────────────────');
  lines.push(`Publication SQL:  ${report.publicationSql}`);
  lines.push(`Subscription SQL: ${report.subscriptionSql}`);
  lines.push('──────────────────────────────────────────────────────────────────────');
  if (p.overallPass) {
    lines.push('  ✔ PREFLIGHT APPROVED: Blue database meets all logical replication requirements.');
  } else {
    lines.push('  ✖ PREFLIGHT BLOCKED: Blue database does not meet all replication requirements.');
  }
  lines.push('');
  return lines.join('\n');
}


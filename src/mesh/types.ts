/**
 * ddlforge - Blue/Green Migration Mesh: Shared Types & Interfaces
 *
 * Common interfaces for the zero-data-loss blue/green migration mesh,
 * logical CDC switchover, and bi-directional rollback parachute (v2.0.0).
 */

// ─── Preflight & Initialization ────────────────────────────────────────────

export type ReplicaIdentityKind = 'full' | 'default' | 'index' | 'nothing';

export interface TableReplicaIdentityInfo {
  schemaName: string;
  tableName: string;
  replicaIdentity: ReplicaIdentityKind;
  hasPrimaryKey: boolean;
  isSafe: boolean; // true if relreplident != 'n' AND has PK
  warning: string | null;
}

export interface MeshPreflightReport {
  walLevel: string;
  isWalLevelLogical: boolean;
  maxReplicationSlots: number;
  usedReplicationSlots: number;
  availableSlots: number;
  maxWalSenders: number;
  tableIdentities: TableReplicaIdentityInfo[];
  unsafeTableCount: number;
  publicationName: string;
  publicationExists: boolean;
  overallPass: boolean;
  warnings: string[];
  checkedAt: Date;
}

export interface MeshInitOptions {
  blueUrl: string;
  greenUrl: string;
  publicationName?: string;
  slotName?: string;
  dryRun?: boolean;
  format?: 'terminal' | 'json';
}

export interface MeshInitReport {
  preflightBlue: MeshPreflightReport;
  publicationSql: string;
  subscriptionSql: string;
  dryRun: boolean;
  checkedAt: Date;
}

// ─── Sequence Synchronization ───────────────────────────────────────────────

export interface SequenceInfo {
  sequenceName: string;
  schemaName: string;
  tableName: string;
  columnName: string;
  isIdentity: boolean;
  currentMax: number;
  lastValue: number;
  padding: number;
  safeWatermark: number;
  setvalSql: string;
}

export interface SequenceSyncReport {
  sequences: SequenceInfo[];
  totalSequences: number;
  executedCount: number;
  dryRun: boolean;
  padding: number;
  checkedAt: Date;
}

export interface SequenceSyncOptions {
  blueUrl: string;
  greenUrl: string;
  padding?: number;
  dryRun?: boolean;
  format?: 'terminal' | 'json';
}

// ─── Cutover State Machine ──────────────────────────────────────────────────

export type CutoverPhase =
  | 'IDLE'
  | 'DRAIN'
  | 'FENCE_BLUE'
  | 'CAPTURE_FENCE'
  | 'WAIT_REPLICATION'
  | 'SYNC_SEQUENCES'
  | 'PROMOTE_GREEN'
  | 'COMPLETE'
  | 'FAILED'
  | 'ABORTED';

export interface CutoverPhaseRecord {
  phase: CutoverPhase;
  startedAt: Date;
  completedAt?: Date;
  durationMs?: number;
  details: string;
}

export interface CutoverReport {
  runId: string;
  blueUrl: string;
  greenUrl: string;
  databaseName: string;
  roleName?: string;
  phases: CutoverPhaseRecord[];
  fenceLsn?: string;
  confirmedFlushLsn?: string;
  lsnLagBytes?: number;
  sequenceSync?: SequenceSyncReport;
  finalPhase: CutoverPhase;
  dryRun: boolean;
  totalDurationMs: number;
  checkedAt: Date;
}

export interface CutoverOptions {
  blueUrl: string;
  greenUrl: string;
  databaseName: string;
  roleName?: string;
  slotName?: string;
  padding?: number;
  timeoutMs?: number;
  drainTimeoutMs?: number;
  pollIntervalMs?: number;
  dryRun?: boolean;
  format?: 'terminal' | 'json';
}

// ─── Rollback Pipeline ──────────────────────────────────────────────────────

export interface ReverseReplicationSetup {
  reversePublicationSql: string;
  reverseSubscriptionSql: string;
  reversePublicationName: string;
  reverseSubscriptionName: string;
  reverseSlotName: string;
}

export interface RollbackEstablishReport {
  reverseSetup: ReverseReplicationSetup;
  executed: boolean;
  dryRun: boolean;
  checkedAt: Date;
}

export interface RollbackReport {
  runId: string;
  blueUrl: string;
  greenUrl: string;
  databaseName: string;
  phases: CutoverPhaseRecord[];
  fenceLsn?: string;
  confirmedFlushLsn?: string;
  finalPhase: CutoverPhase;
  dryRun: boolean;
  totalDurationMs: number;
  checkedAt: Date;
}

export interface RollbackOptions {
  blueUrl: string;
  greenUrl: string;
  databaseName: string;
  roleName?: string;
  slotName?: string;
  padding?: number;
  timeoutMs?: number;
  pollIntervalMs?: number;
  dryRun?: boolean;
  format?: 'terminal' | 'json';
}

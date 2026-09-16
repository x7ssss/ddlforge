/**
 * ddlforge - Postgres Lock levels and concurrency conflict model
 */

export enum PostgresLockLevel {
  ACCESS_SHARE = 'ACCESS SHARE',
  ROW_SHARE = 'ROW SHARE',
  ROW_EXCLUSIVE = 'ROW EXCLUSIVE',
  SHARE_UPDATE_EXCLUSIVE = 'SHARE UPDATE EXCLUSIVE',
  SHARE = 'SHARE',
  SHARE_ROW_EXCLUSIVE = 'SHARE ROW EXCLUSIVE',
  EXCLUSIVE = 'EXCLUSIVE',
  ACCESS_EXCLUSIVE = 'ACCESS EXCLUSIVE',
  NONE = 'NONE',
}

export interface LockMetadata {
  level: PostgresLockLevel;
  rank: number; // 1 to 8 (highest = most restrictive)
  blocksReads: boolean;
  blocksWrites: boolean;
  description: string;
  conflictsWith: PostgresLockLevel[];
}

export const LOCK_METADATA: Record<PostgresLockLevel, LockMetadata> = {
  [PostgresLockLevel.ACCESS_SHARE]: {
    level: PostgresLockLevel.ACCESS_SHARE,
    rank: 1,
    blocksReads: false,
    blocksWrites: false,
    description: 'Read-only queries (SELECT). Permissive.',
    conflictsWith: [PostgresLockLevel.ACCESS_EXCLUSIVE],
  },
  [PostgresLockLevel.ROW_SHARE]: {
    level: PostgresLockLevel.ROW_SHARE,
    rank: 2,
    blocksReads: false,
    blocksWrites: false,
    description: 'Row locks (SELECT FOR UPDATE / FOR SHARE).',
    conflictsWith: [PostgresLockLevel.EXCLUSIVE, PostgresLockLevel.ACCESS_EXCLUSIVE],
  },
  [PostgresLockLevel.ROW_EXCLUSIVE]: {
    level: PostgresLockLevel.ROW_EXCLUSIVE,
    rank: 3,
    blocksReads: false,
    blocksWrites: false,
    description: 'Standard DML (INSERT, UPDATE, DELETE). Conflicts with table-level DDL locks.',
    conflictsWith: [
      PostgresLockLevel.SHARE,
      PostgresLockLevel.SHARE_ROW_EXCLUSIVE,
      PostgresLockLevel.EXCLUSIVE,
      PostgresLockLevel.ACCESS_EXCLUSIVE,
    ],
  },
  [PostgresLockLevel.SHARE_UPDATE_EXCLUSIVE]: {
    level: PostgresLockLevel.SHARE_UPDATE_EXCLUSIVE,
    rank: 4,
    blocksReads: false,
    blocksWrites: false,
    description: 'Concurrent operations (CREATE INDEX CONCURRENTLY, VALIDATE CONSTRAINT, VACUUM). Safe for concurrent reads and writes.',
    conflictsWith: [
      PostgresLockLevel.SHARE_UPDATE_EXCLUSIVE,
      PostgresLockLevel.SHARE,
      PostgresLockLevel.SHARE_ROW_EXCLUSIVE,
      PostgresLockLevel.EXCLUSIVE,
      PostgresLockLevel.ACCESS_EXCLUSIVE,
    ],
  },
  [PostgresLockLevel.SHARE]: {
    level: PostgresLockLevel.SHARE,
    rank: 5,
    blocksReads: false,
    blocksWrites: true,
    description: 'Index creation without CONCURRENTLY. BLOCKS ALL WRITES (INSERT, UPDATE, DELETE).',
    conflictsWith: [
      PostgresLockLevel.ROW_EXCLUSIVE,
      PostgresLockLevel.SHARE_ROW_EXCLUSIVE,
      PostgresLockLevel.EXCLUSIVE,
      PostgresLockLevel.ACCESS_EXCLUSIVE,
    ],
  },
  [PostgresLockLevel.SHARE_ROW_EXCLUSIVE]: {
    level: PostgresLockLevel.SHARE_ROW_EXCLUSIVE,
    rank: 6,
    blocksReads: false,
    blocksWrites: true,
    description: 'Foreign key addition without NOT VALID. BLOCKS ALL WRITES on target and referenced tables.',
    conflictsWith: [
      PostgresLockLevel.ROW_EXCLUSIVE,
      PostgresLockLevel.SHARE_UPDATE_EXCLUSIVE,
      PostgresLockLevel.SHARE,
      PostgresLockLevel.SHARE_ROW_EXCLUSIVE,
      PostgresLockLevel.EXCLUSIVE,
      PostgresLockLevel.ACCESS_EXCLUSIVE,
    ],
  },
  [PostgresLockLevel.EXCLUSIVE]: {
    level: PostgresLockLevel.EXCLUSIVE,
    rank: 7,
    blocksReads: false,
    blocksWrites: true,
    description: 'Exclusive lock. Blocks row-share and all writes.',
    conflictsWith: [
      PostgresLockLevel.ROW_SHARE,
      PostgresLockLevel.ROW_EXCLUSIVE,
      PostgresLockLevel.SHARE_UPDATE_EXCLUSIVE,
      PostgresLockLevel.SHARE,
      PostgresLockLevel.SHARE_ROW_EXCLUSIVE,
      PostgresLockLevel.EXCLUSIVE,
      PostgresLockLevel.ACCESS_EXCLUSIVE,
    ],
  },
  [PostgresLockLevel.ACCESS_EXCLUSIVE]: {
    level: PostgresLockLevel.ACCESS_EXCLUSIVE,
    rank: 8,
    blocksReads: true,
    blocksWrites: true,
    description: 'FULL TABLE LOCK (ALTER TABLE, DROP TABLE, TRUNCATE). Blocks EVERYTHING, including SELECT.',
    conflictsWith: [
      PostgresLockLevel.ACCESS_SHARE,
      PostgresLockLevel.ROW_SHARE,
      PostgresLockLevel.ROW_EXCLUSIVE,
      PostgresLockLevel.SHARE_UPDATE_EXCLUSIVE,
      PostgresLockLevel.SHARE,
      PostgresLockLevel.SHARE_ROW_EXCLUSIVE,
      PostgresLockLevel.EXCLUSIVE,
      PostgresLockLevel.ACCESS_EXCLUSIVE,
    ],
  },
  [PostgresLockLevel.NONE]: {
    level: PostgresLockLevel.NONE,
    rank: 0,
    blocksReads: false,
    blocksWrites: false,
    description: 'No database lock acquired.',
    conflictsWith: [],
  },
};

export function getLockMetadata(level: PostgresLockLevel): LockMetadata {
  return LOCK_METADATA[level] ?? LOCK_METADATA[PostgresLockLevel.NONE];
}

export function locksConflict(lockA: PostgresLockLevel, lockB: PostgresLockLevel): boolean {
  return LOCK_METADATA[lockA]?.conflictsWith.includes(lockB) ?? false;
}

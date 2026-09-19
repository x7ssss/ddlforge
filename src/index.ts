/**
 * ddlforge - Ultra-fast, zero-runtime-dependency Postgres migration lock linter
 * and data-loss prevention engine.
 */

// Lexer & Tokens
export * from './lexer/tokens.js';
export * from './lexer/sqlTokenizer.js';

// Engine & Locks
export * from './engine/locks.js';
export * from './engine/analyzer.js';

// Rules
export * from './rules/index.js';

// Reporters
export * from './reporters/index.js';

// CLI Utilities
export { parseArgs, discoverSqlFiles, runCli, CliOptions } from './cli.js';

// Wrapper
export * from './wrapper/orchestrator.js';

// Remediations
export * from './remediations/index.js';

// Orchestrator (Slicer, Ledger, Fixer)
export * from './orchestrator/index.js';

// Cluster (Distributed Advisory Locking)
export * from './cluster/index.js';

// Diff (Schema Drift Introspection & AST Comparison)
export * from './diff/index.js';

// Masking (In-Flight Data Masking & Anonymization Engine)
export * from './masking/index.js';

// Partition (Declarative Partition Lifecycle, Conversion & Attachment)
export * from './partition/index.js';

// Pre-flight (Disk & Mount Guard, Replication Lag, Config Risk Auditor)
export * from './preflight/index.js';

// Recovery (Continuous WAL Archiving, Backup RPO Auditor & Restore Verification Engine)
export * from './recovery/index.js';

// Compaction (Zero-Downtime Table Compaction & Online Repack Engine)
export * from './compaction/index.js';

// Distributed (Multi-Tenant Distribution, Distributed DDL State Machine & Drift Auditing)
export * from './distributed/index.js';

// Advisor (Autonomous Query Telemetry, HypoPG Simulation & Index Lifecycle Advisor)
export * from './advisor/index.js';
// Mesh (Zero-Data-Loss Blue/Green Migration Mesh, Logical CDC Switchover & Rollback Parachute)
export * from './mesh/index.js';

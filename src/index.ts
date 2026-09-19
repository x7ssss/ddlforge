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


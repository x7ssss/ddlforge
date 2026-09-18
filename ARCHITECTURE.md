# Architecture Reference

`ddlforge` is an ultra-fast, zero-runtime-dependency PostgreSQL migration lock linter and data-loss prevention engine.

## 1. Compilation & Analysis Pipeline

```
SQL Input (Files / Stdin)
   │
   ▼
[Lexer: sqlTokenizer.ts]  ──► Strips UTF-8 BOM (\uFEFF) & tokenizes keywords/strings/comments
   │
   ▼
[Statement Splitter]      ──► Groups tokens by semicolon, extracts source coordinates & directives
   │
   ▼
[Rule Registry: ALL_RULES]──► 19 deterministic AST-lite inspection rules with lock taxonomy
   │
   ▼
[MigrationAnalyzer]       ──► Evaluates context, matches lock hazards, and computes findings
   │
   ▼
[Reporters & Remediation] ──► Terminal, Markdown, JSON, SARIF 2.1.0, and multi-phase recipes
```

- **Lexer (`src/lexer/sqlTokenizer.ts`)**: Single-pass zero-allocation tokenizer tracking lines, columns, and comment directives. Handles dollar-quotes (`$$`, `$tag$`), identifiers, and operators.
- **Statement Parsing (`src/lexer/tokens.ts`)**: AST-lite representation maintaining raw tokens, inline `-- ddlforge-ignore` directives, and source spans.
- **Rule Pipeline (`src/rules/` & `src/engine/analyzer.ts`)**: Pure deterministic AST and token matching. Computes PostgreSQL lock levels (`ACCESS EXCLUSIVE`, `SHARE`, etc.) without runtime external dependencies.
- **Remediation Engine (`src/remediations/`)**: Generates automated, multi-phase zero-downtime transition recipes with injected `SET LOCAL lock_timeout = '2s';` and resumable batched DML loops.

## 2. Command Execution Flows

### A. Pre-Flight ORM Wrapper (`src/wrapper/orchestrator.ts`)
1. **Discovery**: Auto-detects Prisma (`prisma/migrations`) or Drizzle (`drizzle/`) folder structures.
2. **Pending Filter**: Compares pending migration files against DB migration history (`_prisma_migrations`, `__drizzle_migrations`).
3. **Safety Interception**: Invokes `MigrationAnalyzer`. If any `BLOCKER` is detected, it logs full diagnostics and aborts (`exitCode: 1`) before executing the ORM runner.
4. **Delegation**: On clean validation (or `--allow-blockers`), delegates to the ORM process via `spawnSync` with inherited `stdio`.

### B. Supervised Execution Runner (`src/runner/`)
1. **Non-Transactional Branching (`executor.ts`)**: Categorizes statements into transactional blocks vs. isolated autocommit operations (`CONCURRENTLY`, `VACUUM`).
2. **Timeout Injection**: Injects session-level `SET LOCAL lock_timeout` and `statement_timeout`.
3. **Lock Queue Avalanche Breaker (`locksMonitor.ts`)**: Background connection polls `pg_locks` for blocked backends; cancels query if queue threshold exceeded.
4. **Retry & Backoff (`backoff.ts`)**: Retries on lock timeout errors (`55P03`, `57014`) using randomized exponential backoff with full jitter.

## 3. Developer Invariants

1. **UTF-8 BOM Invariant**: All input boundaries (`SqlTokenizer`, `splitStatements`, `MigrationAnalyzer.analyze`) must strip leading `\uFEFF` (`0xFEFF`) to prevent keyword token corruption.
2. **Rule Registration**: Every new rule must be exported and registered in `ALL_RULES` within `src/rules/index.ts`.
3. **Zero Runtime Dependencies**: The core linter, lexer, AST analyzer, wrapper, and CLI must maintain **zero runtime npm dependencies** (pure TypeScript + Node.js standard library).

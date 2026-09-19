# Example 03: Automated CI/CD Reliability Gate

This directory contains a complete, drop-in GitHub Actions workflow (`workflow.yml` and `.github/workflows/ddlforge-gate.yml`) that runs automated zero-downtime checks on every Pull Request modifying database migrations.

## What the Gate Validates:

1. **Static Migration Lock Linting (`ddlforge check --format github`)**:
   - Parses migration ASTs without requiring database credentials.
   - Emits native GitHub PR diff annotations (`::error file=... line=... title=ddlforge::...`).
   - Rejects lock hazards (`ACCESS EXCLUSIVE` without timeouts, missing `CONCURRENTLY`, non-transactional DDL).
2. **Disaster Recovery Health (`ddlforge doctor`)**:
   - Validates that `wal_level = logical` or archival commands are healthy.
   - Guards against failed archive backlogs.
3. **Preflight Capacity & Replication Lag (`ddlforge preflight`)**:
   - Forecasts WAL volume and verifies sufficient replication slot headroom.
4. **Ephemeral Test Harness (`ddlforge test`)**:
   - Spins up ephemeral isolated PostgreSQL 17 test containers via Testcontainers.
   - Runs migrations while sampling lock hold durations every 50ms.
   - Fails the PR if any lock hold duration exceeds `--max-lock-ms 500`.

## Installation into Your Repository

Copy `workflow.yml` to `.github/workflows/ddlforge-gate.yml` in your repository:

```bash
mkdir -p .github/workflows
cp examples/03-ci-pipeline/workflow.yml .github/workflows/ddlforge-gate.yml
```

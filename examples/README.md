# ddlforge Production Migration Examples

This directory contains runnable real-world scenarios demonstrating zero-downtime database migrations with `ddlforge v2.0.0`.

## Quickstart: Local Environment Setup

A pre-configured PostgreSQL 16 instance with logical replication and telemetry enabled is provided:

```bash
# 1. Start local PostgreSQL
docker compose up -d

# Verify connectivity:
psql postgresql://postgres:postgrespassword@localhost:5432/postgres -c "SELECT version();"
```

## Available Scenarios

### [1. Safe NOT NULL Column Addition (`01-safe-column-add/`)](./01-safe-column-add/)
- **Problem**: Adding a `NOT NULL` column with default value to a 10M-row table locks out concurrent queries.
- **Solution**: 3-phase expand/contract with asynchronous keyset batch backfill.
- **Command**: `npx ddlforge check 01-safe-column-add/unsafe_migration.sql`

### [2. Zero-Downtime Partitioning (`02-partition-live-table/`)](./02-partition-live-table/)
- **Problem**: Converting a monolithic 50M+ row table into range partitions causes massive downtime.
- **Solution**: Target partitioned table creation, dual-write triggers, keyset backfill, and sub-second cutover swap.
- **Command**: `npx ddlforge apply 02-partition-live-table/05_atomic_cutover.sql --lock-timeout 250ms`

### [3. Automated CI/CD Reliability Gate (`03-ci-pipeline/`)](./03-ci-pipeline/)
- **Problem**: Hazardous DDL slipping through peer review and reaching production.
- **Solution**: Ready-to-use GitHub Actions workflow executing static linting, disaster doctor, and ephemeral test container validation before merge.

---

## Interactive Demo

You can also run the built-in interactive terminal demo without spinning up Docker:

```bash
npx ddlforge demo
```

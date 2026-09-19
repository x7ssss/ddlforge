-- PHASE 1 (EXPAND): Add nullable column with default in sub-millisecond transaction
-- In PostgreSQL 11+, non-volatile defaults are recorded in catalog pg_attribute
-- without rewriting existing table heap pages.
SET LOCAL lock_timeout = '250ms';
SET LOCAL statement_timeout = '2s';

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_verified BOOLEAN DEFAULT true;

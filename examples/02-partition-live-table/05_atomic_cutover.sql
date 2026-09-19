-- Step 5: Bounded Atomic Cutover
-- Swaps the tables using an atomic transaction with a strict 250ms lock timeout.
-- If the lock cannot be acquired immediately, it cancels without causing a pileup.
BEGIN;

SET LOCAL lock_timeout = '250ms';
SET LOCAL statement_timeout = '5s';

-- Drop dual-write trigger
DROP TRIGGER IF EXISTS trg_events_dual_write ON events;
DROP FUNCTION IF EXISTS fn_events_dual_write();

-- Atomic table rename swap
ALTER TABLE events RENAME TO events_legacy;
ALTER TABLE events_partitioned RENAME TO events;

COMMIT;

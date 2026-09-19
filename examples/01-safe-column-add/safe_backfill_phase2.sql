-- PHASE 2 (ASYNC BACKFILL): Backfill historical rows using keyset pagination
-- Each batch updates 5,000 rows, commits independently, and sleeps with jitter
-- to prevent replication lag and catalog lock convoys.
DO $$
DECLARE
    v_last_id BIGINT := 0;
    v_rows_updated INT := 0;
    v_batch_size INT := 5000;
BEGIN
    LOOP
        UPDATE users
        SET is_verified = true
        WHERE id IN (
            SELECT id
            FROM users
            WHERE id > v_last_id
              AND is_verified IS NULL
            ORDER BY id ASC
            LIMIT v_batch_size
            FOR UPDATE SKIP LOCKED
        );
        
        GET DIAGNOSTICS v_rows_updated = ROW_COUNT;
        EXIT WHEN v_rows_updated = 0;
        
        SELECT MAX(id) INTO v_last_id
        FROM (
            SELECT id FROM users WHERE id > v_last_id ORDER BY id ASC LIMIT v_batch_size
        ) sub;

        -- Sleep 25ms to throttle I/O and let WAL writer flush
        PERFORM pg_sleep(0.025);
    END LOOP;
END;
$$;

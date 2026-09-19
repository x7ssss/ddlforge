-- Step 4: Asynchronous Keyset Backfill
-- Copies historical records from monolithic events to partitioned table.
-- Keyset pagination on id avoids sequential scan thrashing.
DO $$
DECLARE
    v_last_id BIGINT := 0;
    v_rows_copied INT := 0;
    v_batch_size INT := 5000;
BEGIN
    LOOP
        INSERT INTO events_partitioned (id, event_type, payload, created_at)
        SELECT id, event_type, payload, created_at
        FROM events
        WHERE id > v_last_id
        ORDER BY id ASC
        LIMIT v_batch_size
        ON CONFLICT (id, created_at) DO NOTHING;

        GET DIAGNOSTICS v_rows_copied = ROW_COUNT;
        EXIT WHEN v_rows_copied = 0;

        SELECT MAX(id) INTO v_last_id
        FROM (
            SELECT id FROM events WHERE id > v_last_id ORDER BY id ASC LIMIT v_batch_size
        ) sub;

        -- Sleep 20ms to allow concurrent write I/O
        PERFORM pg_sleep(0.020);
    END LOOP;
END;
$$;

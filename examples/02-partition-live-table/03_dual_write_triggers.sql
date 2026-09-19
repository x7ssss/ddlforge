-- Step 3: Install zero-downtime dual-write trigger
-- Captures new writes while historical backfill is running.
-- Uses pg_trigger_depth() < 2 to prevent cascading loops.
CREATE OR REPLACE FUNCTION fn_events_dual_write()
RETURNS TRIGGER AS $$
BEGIN
    IF pg_trigger_depth() < 2 THEN
        IF TG_OP = 'INSERT' THEN
            INSERT INTO events_partitioned (id, event_type, payload, created_at)
            VALUES (NEW.id, NEW.event_type, NEW.payload, NEW.created_at)
            ON CONFLICT (id, created_at) DO NOTHING;
        ELSIF TG_OP = 'UPDATE' THEN
            UPDATE events_partitioned
            SET event_type = NEW.event_type,
                payload = NEW.payload,
                created_at = NEW.created_at
            WHERE id = NEW.id AND created_at = OLD.created_at;
        ELSIF TG_OP = 'DELETE' THEN
            DELETE FROM events_partitioned WHERE id = OLD.id AND created_at = OLD.created_at;
        END IF;
    END IF;
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_events_dual_write ON events;
CREATE TRIGGER trg_events_dual_write
    AFTER INSERT OR UPDATE OR DELETE ON events
    FOR EACH ROW EXECUTE FUNCTION fn_events_dual_write();

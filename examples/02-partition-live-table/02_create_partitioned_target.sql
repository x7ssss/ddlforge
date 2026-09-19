-- Step 2: Create target range-partitioned table by month
CREATE TABLE IF NOT EXISTS events_partitioned (
    id BIGINT NOT NULL,
    event_type VARCHAR(64) NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- Attach monthly partitions
CREATE TABLE IF NOT EXISTS events_y2026m07 PARTITION OF events_partitioned
    FOR VALUES FROM ('2026-07-01 00:00:00+00') TO ('2026-08-01 00:00:00+00');

CREATE TABLE IF NOT EXISTS events_y2026m08 PARTITION OF events_partitioned
    FOR VALUES FROM ('2026-08-01 00:00:00+00') TO ('2026-09-01 00:00:00+00');

CREATE TABLE IF NOT EXISTS events_y2026m09 PARTITION OF events_partitioned
    FOR VALUES FROM ('2026-09-01 00:00:00+00') TO ('2026-10-01 00:00:00+00');

CREATE TABLE IF NOT EXISTS events_default PARTITION OF events_partitioned DEFAULT;

-- Local partition indexes
CREATE INDEX IF NOT EXISTS idx_events_part_type ON events_partitioned (event_type);

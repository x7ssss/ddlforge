-- Initial monolithic 50M+ row events table
CREATE TABLE IF NOT EXISTS events (
    id BIGSERIAL,
    event_type VARCHAR(64) NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (id, created_at)
);

-- Seed initial test events
INSERT INTO events (event_type, payload, created_at)
SELECT 
    'user.login',
    jsonb_build_object('ip', '192.168.1.' || (g % 255), 'session_id', md5(g::text)),
    NOW() - (interval '1 day' * (g % 90))
FROM generate_series(1, 10000) AS g;

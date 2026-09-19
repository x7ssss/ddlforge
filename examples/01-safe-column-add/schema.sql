-- Initial high-traffic production table
CREATE TABLE IF NOT EXISTS users (
    id BIGSERIAL PRIMARY KEY,
    email VARCHAR(255) NOT NULL UNIQUE,
    full_name VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed mock records for testing
INSERT INTO users (email, full_name)
SELECT 
    'user_' || g || '@example.com',
    'User ' || g
FROM generate_series(1, 10000) AS g
ON CONFLICT (email) DO NOTHING;

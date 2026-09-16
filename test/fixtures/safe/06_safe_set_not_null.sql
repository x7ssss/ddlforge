-- Safe: NOT NULL added via validated CHECK constraint without full table lock in PG 12+
ALTER TABLE users ADD CONSTRAINT chk_bio_not_null CHECK (bio IS NOT NULL) NOT VALID;
ALTER TABLE users VALIDATE CONSTRAINT chk_bio_not_null;

-- ddlforge-ignore set-not-null-full-scan
ALTER TABLE users ALTER COLUMN bio SET NOT NULL;

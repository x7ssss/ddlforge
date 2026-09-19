-- PHASE 3 (CONTRACT): Enforce NOT NULL constraint using two-step validation
-- Step 3A: Add NOT VALID check constraint (sub-millisecond catalog lock)
SET LOCAL lock_timeout = '250ms';
ALTER TABLE users ADD CONSTRAINT chk_users_is_verified_not_null 
CHECK (is_verified IS NOT NULL) NOT VALID;

-- Step 3B: Validate constraint concurrently without table write locks (SHARE UPDATE EXCLUSIVE)
ALTER TABLE users VALIDATE CONSTRAINT chk_users_is_verified_not_null;

-- Dangerous: Direct SET NOT NULL performs table scan holding ACCESS EXCLUSIVE
ALTER TABLE users ALTER COLUMN age SET NOT NULL;

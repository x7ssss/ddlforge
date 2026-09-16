-- Unsafe: ADD CONSTRAINT CHECK without NOT VALID causes full table scan
ALTER TABLE orders ADD CONSTRAINT orders_amount_positive CHECK (amount > 0);
ALTER TABLE orders ADD CONSTRAINT orders_status_valid CHECK (status IN ('pending', 'complete', 'cancelled'));

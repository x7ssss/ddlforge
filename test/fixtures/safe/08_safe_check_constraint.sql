-- Safe: Two-phase CHECK constraint with NOT VALID + VALIDATE CONSTRAINT
ALTER TABLE orders ADD CONSTRAINT orders_amount_positive CHECK (amount > 0) NOT VALID;
ALTER TABLE orders VALIDATE CONSTRAINT orders_amount_positive;

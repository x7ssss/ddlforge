-- Dangerous: Foreign key added without NOT VALID takes table lock
ALTER TABLE orders ADD CONSTRAINT fk_orders_user_id FOREIGN KEY (user_id) REFERENCES users(id);

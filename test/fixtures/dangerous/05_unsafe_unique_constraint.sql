-- Unsafe: ADD CONSTRAINT UNIQUE directly takes SHARE lock and table scan
ALTER TABLE users ADD CONSTRAINT users_email_unique UNIQUE (email);
ALTER TABLE products ADD CONSTRAINT products_sku_unique UNIQUE (sku, tenant_id);

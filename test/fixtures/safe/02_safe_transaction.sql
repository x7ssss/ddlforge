-- prisma:no-transaction
-- Safe: Prisma migration with explicit no-transaction directive
CREATE INDEX CONCURRENTLY idx_posts_created_at ON posts(created_at);

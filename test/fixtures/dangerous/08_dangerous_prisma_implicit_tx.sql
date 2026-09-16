-- CreateIndex
-- Prisma migration containing CONCURRENTLY without the required directive
CREATE INDEX CONCURRENTLY "users_created_at_idx" ON "users"("created_at");

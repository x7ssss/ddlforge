-- AlterTable: Dangerous silent field rename in Prisma wiping data
ALTER TABLE "users" DROP COLUMN "old_email";
ALTER TABLE "users" ADD COLUMN "new_email" TEXT NOT NULL;

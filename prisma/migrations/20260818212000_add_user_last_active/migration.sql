ALTER TABLE "User" ADD COLUMN "lastActiveAt" TIMESTAMP(3);
CREATE INDEX "User_lastActiveAt_idx" ON "User"("lastActiveAt" DESC);

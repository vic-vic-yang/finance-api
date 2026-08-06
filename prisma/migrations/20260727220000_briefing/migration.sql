-- AlterTable
ALTER TABLE "User" ADD COLUMN     "briefingEnabled" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "Briefing" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "ledgerId" TEXT NOT NULL,
    "weekStart" TIMESTAMP(3) NOT NULL,
    "factsJson" TEXT NOT NULL,
    "narrative" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Briefing_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Briefing_userId_ledgerId_createdAt_idx" ON "Briefing"("userId", "ledgerId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Briefing_userId_ledgerId_weekStart_key" ON "Briefing"("userId", "ledgerId", "weekStart");

-- AddForeignKey
ALTER TABLE "Briefing" ADD CONSTRAINT "Briefing_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Briefing" ADD CONSTRAINT "Briefing_ledgerId_fkey" FOREIGN KEY ("ledgerId") REFERENCES "Ledger"("id") ON DELETE CASCADE ON UPDATE CASCADE;

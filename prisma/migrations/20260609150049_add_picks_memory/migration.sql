-- AlterTable
ALTER TABLE "DailyPick" ADD COLUMN     "lastPrice" DOUBLE PRECISION,
ADD COLUMN     "outcomeAt" TIMESTAMP(3),
ADD COLUMN     "outcomePct" DOUBLE PRECISION;

-- CreateTable
CREATE TABLE "PicksMemory" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "playbook" TEXT NOT NULL DEFAULT '',
    "stats" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PicksMemory_pkey" PRIMARY KEY ("id")
);

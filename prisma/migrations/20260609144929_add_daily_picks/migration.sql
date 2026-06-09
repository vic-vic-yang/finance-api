-- CreateTable
CREATE TABLE "DailyPickRun" (
    "id" TEXT NOT NULL,
    "tradeDate" TEXT NOT NULL,
    "boards" TEXT NOT NULL,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DailyPickRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyPick" (
    "id" TEXT NOT NULL,
    "tradeDate" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "boardName" TEXT NOT NULL,
    "price" DOUBLE PRECISION,
    "changePercent" DOUBLE PRECISION,
    "pe" DOUBLE PRECISION,
    "pb" DOUBLE PRECISION,
    "score" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "risk" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DailyPick_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DailyPickRun_tradeDate_key" ON "DailyPickRun"("tradeDate");

-- CreateIndex
CREATE INDEX "DailyPick_tradeDate_rank_idx" ON "DailyPick"("tradeDate", "rank");

-- CreateIndex
CREATE UNIQUE INDEX "DailyPick_tradeDate_code_key" ON "DailyPick"("tradeDate", "code");

-- AddForeignKey
ALTER TABLE "DailyPick" ADD CONSTRAINT "DailyPick_runId_fkey" FOREIGN KEY ("runId") REFERENCES "DailyPickRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

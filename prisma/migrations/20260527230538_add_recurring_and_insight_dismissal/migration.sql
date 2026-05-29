-- CreateTable
CREATE TABLE "RecurringBill" (
    "id" TEXT NOT NULL,
    "ledgerId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "type" "BillType" NOT NULL DEFAULT 'expense',
    "amount" DECIMAL(15,2) NOT NULL,
    "noteCipher" BYTEA,
    "noteDekVer" INTEGER,
    "cycleType" TEXT NOT NULL DEFAULT 'monthly',
    "cycleDay" INTEGER NOT NULL,
    "nextDate" TIMESTAMP(3) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isAuto" BOOLEAN NOT NULL DEFAULT false,
    "confidence" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecurringBill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiInsightDismissal" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "ledgerId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "dismissedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expireAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiInsightDismissal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RecurringBill_ledgerId_isActive_idx" ON "RecurringBill"("ledgerId", "isActive");

-- CreateIndex
CREATE INDEX "RecurringBill_nextDate_idx" ON "RecurringBill"("nextDate");

-- CreateIndex
CREATE INDEX "AiInsightDismissal_userId_ledgerId_idx" ON "AiInsightDismissal"("userId", "ledgerId");

-- CreateIndex
CREATE INDEX "AiInsightDismissal_expireAt_idx" ON "AiInsightDismissal"("expireAt");

-- CreateIndex
CREATE UNIQUE INDEX "AiInsightDismissal_userId_ledgerId_type_target_key" ON "AiInsightDismissal"("userId", "ledgerId", "type", "target");

-- AddForeignKey
ALTER TABLE "RecurringBill" ADD CONSTRAINT "RecurringBill_ledgerId_fkey" FOREIGN KEY ("ledgerId") REFERENCES "Ledger"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringBill" ADD CONSTRAINT "RecurringBill_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringBill" ADD CONSTRAINT "RecurringBill_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

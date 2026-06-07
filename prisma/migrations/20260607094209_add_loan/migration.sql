-- CreateTable
CREATE TABLE "Loan" (
    "id" TEXT NOT NULL,
    "ledgerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "amount" DECIMAL(15,2) NOT NULL,
    "repaidAmount" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "accountId" TEXT,
    "noteCipher" TEXT,
    "noteDekVer" INTEGER NOT NULL DEFAULT 1,
    "voucherKey" TEXT,
    "date" TIMESTAMP(3) NOT NULL,
    "settledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Loan_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Loan_ledgerId_direction_settledAt_idx" ON "Loan"("ledgerId", "direction", "settledAt");

-- CreateIndex
CREATE INDEX "Loan_ledgerId_createdAt_idx" ON "Loan"("ledgerId", "createdAt");

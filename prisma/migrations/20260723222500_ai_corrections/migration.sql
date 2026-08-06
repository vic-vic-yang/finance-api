-- CreateTable
CREATE TABLE "AiCorrection" (
    "id" TEXT NOT NULL,
    "ledgerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "merchantKey" VARCHAR(100) NOT NULL,
    "categoryId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiCorrection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiCorrection_ledgerId_merchantKey_idx" ON "AiCorrection"("ledgerId", "merchantKey");

-- CreateIndex
CREATE UNIQUE INDEX "AiCorrection_ledgerId_merchantKey_key" ON "AiCorrection"("ledgerId", "merchantKey");

-- AddForeignKey
ALTER TABLE "AiCorrection" ADD CONSTRAINT "AiCorrection_ledgerId_fkey" FOREIGN KEY ("ledgerId") REFERENCES "Ledger"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiCorrection" ADD CONSTRAINT "AiCorrection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

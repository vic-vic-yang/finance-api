-- AlterTable
ALTER TABLE "Bill" ADD COLUMN     "externalId" TEXT,
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'manual';

-- CreateIndex
CREATE INDEX "Bill_ledgerId_externalId_idx" ON "Bill"("ledgerId", "externalId");

-- CreateIndex
CREATE INDEX "Bill_ledgerId_accountId_date_idx" ON "Bill"("ledgerId", "accountId", "date");

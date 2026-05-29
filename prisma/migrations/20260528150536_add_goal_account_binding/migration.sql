-- AlterTable
ALTER TABLE "SavingsGoal" ADD COLUMN     "accountId" TEXT,
ADD COLUMN     "initialBalance" DECIMAL(15,2);

-- AddForeignKey
ALTER TABLE "SavingsGoal" ADD CONSTRAINT "SavingsGoal_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

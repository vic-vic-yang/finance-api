-- AlterTable
ALTER TABLE "StockHolding" ADD COLUMN     "accountId" TEXT,
ADD COLUMN     "lastCalcAt" TIMESTAMP(3),
ADD COLUMN     "lastPrice" DOUBLE PRECISION,
ADD COLUMN     "ledgerId" TEXT;

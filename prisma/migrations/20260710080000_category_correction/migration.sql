-- AlterTable
ALTER TABLE "Bill" ADD COLUMN "merchantHash" TEXT;

-- CreateTable
CREATE TABLE "CategoryCorrection" (
    "id" TEXT NOT NULL,
    "ledgerId" TEXT NOT NULL,
    "merchantHash" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CategoryCorrection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CategoryCorrection_ledgerId_merchantHash_key" ON "CategoryCorrection"("ledgerId", "merchantHash");

-- CreateIndex
CREATE INDEX "CategoryCorrection_ledgerId_idx" ON "CategoryCorrection"("ledgerId");

-- CreateTable
CREATE TABLE "CategorySort" (
    "id" TEXT NOT NULL,
    "ledgerId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CategorySort_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CategorySort_ledgerId_categoryId_key" ON "CategorySort"("ledgerId", "categoryId");

-- CreateIndex
CREATE INDEX "CategorySort_ledgerId_idx" ON "CategorySort"("ledgerId");

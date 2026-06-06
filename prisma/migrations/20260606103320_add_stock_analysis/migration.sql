-- CreateTable
CREATE TABLE "StockAnalysis" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "name" TEXT,
    "nameZh" TEXT,
    "quote" JSONB NOT NULL,
    "analysis" TEXT,
    "news" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockAnalysis_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StockAnalysis_userId_symbol_createdAt_idx" ON "StockAnalysis"("userId", "symbol", "createdAt");

-- CreateIndex
CREATE INDEX "StockAnalysis_userId_createdAt_idx" ON "StockAnalysis"("userId", "createdAt");

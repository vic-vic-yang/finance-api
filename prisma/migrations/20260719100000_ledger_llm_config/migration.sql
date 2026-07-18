-- CreateTable
CREATE TABLE "LedgerLlmConfig" (
    "id" TEXT NOT NULL,
    "ledgerId" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'custom',
    "baseUrl" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "visionModelId" TEXT,
    "apiKeyEnc" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LedgerLlmConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LedgerLlmConfig_ledgerId_key" ON "LedgerLlmConfig"("ledgerId");

-- CreateIndex
CREATE INDEX "LedgerLlmConfig_ownerUserId_idx" ON "LedgerLlmConfig"("ownerUserId");

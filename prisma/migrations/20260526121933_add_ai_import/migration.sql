-- CreateEnum
CREATE TYPE "AiImportStatus" AS ENUM ('pending', 'extracting', 'parsing', 'dedupping', 'review_ready', 'applying', 'done', 'failed', 'partial');

-- CreateTable
CREATE TABLE "AiImport" (
    "id" TEXT NOT NULL,
    "ledgerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "fileType" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "modelName" TEXT NOT NULL,
    "status" "AiImportStatus" NOT NULL DEFAULT 'pending',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "message" TEXT,
    "parsedCount" INTEGER NOT NULL DEFAULT 0,
    "dupCount" INTEGER NOT NULL DEFAULT 0,
    "insertedCount" INTEGER NOT NULL DEFAULT 0,
    "draftsJson" TEXT,
    "rawOutput" TEXT,
    "errorTrace" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiImport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiImport_userId_createdAt_idx" ON "AiImport"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AiImport_ledgerId_status_idx" ON "AiImport"("ledgerId", "status");

-- AddForeignKey
ALTER TABLE "AiImport" ADD CONSTRAINT "AiImport_ledgerId_fkey" FOREIGN KEY ("ledgerId") REFERENCES "Ledger"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiImport" ADD CONSTRAINT "AiImport_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

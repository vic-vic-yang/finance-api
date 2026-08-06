-- CreateTable
CREATE TABLE "CfoAutoRule" (
    "id" TEXT NOT NULL,
    "ledgerId" TEXT NOT NULL,
    "actionType" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CfoAutoRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CfoAutoRule_ledgerId_actionType_key" ON "CfoAutoRule"("ledgerId", "actionType");

-- AddForeignKey
ALTER TABLE "CfoAutoRule" ADD CONSTRAINT "CfoAutoRule_ledgerId_fkey" FOREIGN KEY ("ledgerId") REFERENCES "Ledger"("id") ON DELETE CASCADE ON UPDATE CASCADE;

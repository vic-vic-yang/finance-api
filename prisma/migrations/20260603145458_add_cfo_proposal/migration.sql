-- CreateTable
CREATE TABLE "Proposal" (
    "id" TEXT NOT NULL,
    "ledgerId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "severity" TEXT NOT NULL DEFAULT 'warning',
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "actionKind" TEXT,
    "actionParams" JSONB,
    "requiresClient" BOOLEAN NOT NULL DEFAULT false,
    "evidenceRefs" JSONB,
    "dedupeKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "Proposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProposalFeedback" (
    "id" TEXT NOT NULL,
    "ledgerId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "dismissed" INTEGER NOT NULL DEFAULT 0,
    "approved" INTEGER NOT NULL DEFAULT 0,
    "mutedUntil" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProposalFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Proposal_ledgerId_status_idx" ON "Proposal"("ledgerId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Proposal_ledgerId_dedupeKey_key" ON "Proposal"("ledgerId", "dedupeKey");

-- CreateIndex
CREATE UNIQUE INDEX "ProposalFeedback_ledgerId_type_key" ON "ProposalFeedback"("ledgerId", "type");

-- AddForeignKey
ALTER TABLE "Proposal" ADD CONSTRAINT "Proposal_ledgerId_fkey" FOREIGN KEY ("ledgerId") REFERENCES "Ledger"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ReleaseJob" (
    "id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "buildNumber" INTEGER NOT NULL,
    "versionBump" TEXT NOT NULL,
    "releaseType" TEXT NOT NULL,
    "notes" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "githubRunId" TEXT,
    "apkFile" TEXT,
    "apkSize" INTEGER,
    "downloadUrl" TEXT,
    "errorMessage" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "ReleaseJob_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ReleaseJob_status_createdAt_idx" ON "ReleaseJob"("status", "createdAt");
CREATE INDEX "ReleaseJob_createdById_createdAt_idx" ON "ReleaseJob"("createdById", "createdAt");
ALTER TABLE "ReleaseJob" ADD CONSTRAINT "ReleaseJob_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

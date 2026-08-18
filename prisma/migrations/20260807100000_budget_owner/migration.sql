-- 给 Budget 加 ownerId，支持"共同预算责任人"（null=共享/全员）
ALTER TABLE "Budget" ADD COLUMN "ownerId" TEXT;

ALTER TABLE "Budget"
  ADD CONSTRAINT "Budget_ownerId_fkey"
  FOREIGN KEY ("ownerId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Budget_ownerId_idx" ON "Budget"("ownerId");

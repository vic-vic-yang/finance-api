-- 给 Account 加 ownerId，支持"私人账户 / 共享账户"区分
ALTER TABLE "Account" ADD COLUMN "ownerId" TEXT;

ALTER TABLE "Account"
  ADD CONSTRAINT "Account_ownerId_fkey"
  FOREIGN KEY ("ownerId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Account_ownerId_idx" ON "Account"("ownerId");

-- 回填：现有账户的 ownerId 默认设为所在账本的创建者
-- （保守策略：默认全部私人化，老用户可手动改成共享）
UPDATE "Account" a
SET "ownerId" = l."ownerId"
FROM "Ledger" l
WHERE a."ledgerId" = l.id;

-- ─────────────────────────────────────────────────────────────
-- Migration: shared ledgers (account books)
-- 引入 Ledger / LedgerMember / LedgerInvite 三张表
-- 把 Account / Bill / Budget / Category 改为按 Ledger 隔离
-- 为现有每个用户自动创建一个"我的账本"并迁移历史数据
-- ─────────────────────────────────────────────────────────────

-- 1. 枚举
CREATE TYPE "LedgerRole" AS ENUM ('owner', 'member');

-- 2. 三张新表
CREATE TABLE "Ledger" (
  "id"         TEXT NOT NULL,
  "name"       TEXT NOT NULL,
  "icon"       TEXT,
  "ownerId"    TEXT NOT NULL,
  "isPersonal" BOOLEAN NOT NULL DEFAULT false,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Ledger_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Ledger_ownerId_idx" ON "Ledger"("ownerId");

CREATE TABLE "LedgerMember" (
  "id"       TEXT NOT NULL,
  "ledgerId" TEXT NOT NULL,
  "userId"   TEXT NOT NULL,
  "role"     "LedgerRole" NOT NULL DEFAULT 'member',
  "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LedgerMember_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "LedgerMember_ledgerId_userId_key" ON "LedgerMember"("ledgerId", "userId");
CREATE INDEX "LedgerMember_userId_idx" ON "LedgerMember"("userId");

CREATE TABLE "LedgerInvite" (
  "id"        TEXT NOT NULL,
  "ledgerId"  TEXT NOT NULL,
  "code"      TEXT NOT NULL,
  "createdBy" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "usedBy"    TEXT,
  "usedAt"    TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LedgerInvite_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "LedgerInvite_code_key" ON "LedgerInvite"("code");
CREATE INDEX "LedgerInvite_ledgerId_idx" ON "LedgerInvite"("ledgerId");

-- 3. User 加 currentLedgerId
ALTER TABLE "User" ADD COLUMN "currentLedgerId" TEXT;

-- 4. 给现有表加可空 ledgerId（之后回填，再设为 NOT NULL）
ALTER TABLE "Account"  ADD COLUMN "ledgerId" TEXT;
ALTER TABLE "Bill"     ADD COLUMN "ledgerId" TEXT;
ALTER TABLE "Budget"   ADD COLUMN "ledgerId" TEXT;
ALTER TABLE "Category" ADD COLUMN "ledgerId" TEXT;

-- 5. 为每个用户创建一个"我的账本"
INSERT INTO "Ledger" ("id", "name", "icon", "ownerId", "isPersonal", "createdAt")
SELECT
  'ldg_' || u.id,
  '我的账本',
  '💰',
  u.id,
  true,
  CURRENT_TIMESTAMP
FROM "User" u;

-- 6. 把用户自己加为 owner 成员
INSERT INTO "LedgerMember" ("id", "ledgerId", "userId", "role", "joinedAt")
SELECT
  'lmb_' || u.id,
  'ldg_' || u.id,
  u.id,
  'owner'::"LedgerRole",
  CURRENT_TIMESTAMP
FROM "User" u;

-- 7. 设置每个用户的当前账本
UPDATE "User" SET "currentLedgerId" = 'ldg_' || "id";

-- 8. 回填现有数据的 ledgerId（按原 userId 找对应账本）
UPDATE "Account" SET "ledgerId" = 'ldg_' || "userId";
UPDATE "Bill"    SET "ledgerId" = 'ldg_' || "userId";
UPDATE "Budget"  SET "ledgerId" = 'ldg_' || "userId";
-- 用户自建分类(非系统)归属其个人账本；系统分类 ledgerId 保持 NULL
UPDATE "Category" SET "ledgerId" = 'ldg_' || "userId" WHERE "userId" IS NOT NULL;

-- 9. ledgerId 设为 NOT NULL（Category 除外，系统分类需要 NULL）
ALTER TABLE "Account"  ALTER COLUMN "ledgerId" SET NOT NULL;
ALTER TABLE "Bill"     ALTER COLUMN "ledgerId" SET NOT NULL;
ALTER TABLE "Budget"   ALTER COLUMN "ledgerId" SET NOT NULL;

-- 10. 删掉 Account.userId 和 Budget.userId（Account/Budget 不再绑定单一用户）
--     Bill.userId 保留（标识"记账人"），Category.userId 保留（创建者）
ALTER TABLE "Account" DROP CONSTRAINT IF EXISTS "Account_userId_fkey";
DROP INDEX IF EXISTS "Account_userId_idx";
ALTER TABLE "Account" DROP COLUMN "userId";

ALTER TABLE "Budget" DROP CONSTRAINT IF EXISTS "Budget_userId_fkey";
DROP INDEX IF EXISTS "Budget_userId_idx";
ALTER TABLE "Budget" DROP COLUMN "userId";

-- 11. Bill 旧的索引按 userId 排序，改为按 ledgerId
DROP INDEX IF EXISTS "Bill_userId_date_idx";

-- 12. 创建新索引
CREATE INDEX "Account_ledgerId_idx"   ON "Account"("ledgerId");
CREATE INDEX "Bill_ledgerId_date_idx" ON "Bill"("ledgerId", "date" DESC);
CREATE INDEX "Budget_ledgerId_idx"    ON "Budget"("ledgerId");
CREATE INDEX "Category_ledgerId_idx"  ON "Category"("ledgerId");

-- 13. 外键
ALTER TABLE "Ledger"
  ADD CONSTRAINT "Ledger_ownerId_fkey"
  FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "LedgerMember"
  ADD CONSTRAINT "LedgerMember_ledgerId_fkey"
  FOREIGN KEY ("ledgerId") REFERENCES "Ledger"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "LedgerMember_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "LedgerInvite"
  ADD CONSTRAINT "LedgerInvite_ledgerId_fkey"
  FOREIGN KEY ("ledgerId") REFERENCES "Ledger"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "User"
  ADD CONSTRAINT "User_currentLedgerId_fkey"
  FOREIGN KEY ("currentLedgerId") REFERENCES "Ledger"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Account"
  ADD CONSTRAINT "Account_ledgerId_fkey"
  FOREIGN KEY ("ledgerId") REFERENCES "Ledger"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Bill"
  ADD CONSTRAINT "Bill_ledgerId_fkey"
  FOREIGN KEY ("ledgerId") REFERENCES "Ledger"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Budget"
  ADD CONSTRAINT "Budget_ledgerId_fkey"
  FOREIGN KEY ("ledgerId") REFERENCES "Ledger"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Category"
  ADD CONSTRAINT "Category_ledgerId_fkey"
  FOREIGN KEY ("ledgerId") REFERENCES "Ledger"("id") ON DELETE CASCADE ON UPDATE CASCADE;

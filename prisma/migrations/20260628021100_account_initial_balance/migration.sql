-- AlterTable
ALTER TABLE "Account" ADD COLUMN     "initialBalance" DECIMAL(15,2) NOT NULL DEFAULT 0;

-- 回填老账户初始余额：当前余额 − 历史净收支（含校准调整账单）
-- balance_now = initial + Σ(income +amount / expense -amount)  ⇒  initial = balance_now − Σnet
UPDATE "Account" a
SET "initialBalance" = a.balance - COALESCE((
  SELECT SUM(CASE WHEN b.type = 'income' THEN b.amount ELSE -b.amount END)
  FROM "Bill" b
  WHERE b."accountId" = a.id
), 0);

-- 负债账户增加：贷款本金 / 首次还款日 / 还款方式
ALTER TABLE "Account"
  ADD COLUMN "loanPrincipal"    DECIMAL(15,2),
  ADD COLUMN "firstPaymentDate" TIMESTAMP(3),
  ADD COLUMN "repaymentMethod"  TEXT;

-- 数据修复：把已有负债账户中明显错填成正数的余额翻成负数
-- （负债账户的 balance 约定为负数 = 欠款金额）
UPDATE "Account"
   SET "balance" = -"balance"
 WHERE "type" = 'DEBT' AND "balance" > 0;

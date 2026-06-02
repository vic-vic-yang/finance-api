-- 账户间转账拆成的一收一支账单标记。转账不计入收支统计/预算，但在账单列表可见。
ALTER TABLE "Bill" ADD COLUMN "isTransfer" BOOLEAN NOT NULL DEFAULT false;

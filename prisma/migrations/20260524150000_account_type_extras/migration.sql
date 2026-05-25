-- 账户类型相关的额外字段
--   信用卡: statementDay / dueDay / creditLimit
--   负债: interestRate (复用 dueDay)
--   社保/公积金等自动入账: autoDepositDay / autoDepositAmount / autoDepositCategoryId / lastAutoProcessedAt

ALTER TABLE "Account"
  ADD COLUMN "statementDay"          INTEGER,
  ADD COLUMN "dueDay"                INTEGER,
  ADD COLUMN "creditLimit"           DECIMAL(15,2),
  ADD COLUMN "interestRate"          DECIMAL(6,3),
  ADD COLUMN "autoDepositDay"        INTEGER,
  ADD COLUMN "autoDepositAmount"     DECIMAL(15,2),
  ADD COLUMN "autoDepositCategoryId" TEXT,
  ADD COLUMN "lastAutoProcessedAt"   TIMESTAMP(3);

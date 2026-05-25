-- 把历史 ALIPAY / WECHAT 账户的 type 迁移到新的 VIRTUAL
-- 需要单独的事务：上一个迁移已经 ADD 了 VIRTUAL，到这里才能用
UPDATE "Account" SET "type" = 'VIRTUAL' WHERE "type" IN ('ALIPAY', 'WECHAT');

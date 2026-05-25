-- Account types overhaul：
--   新增 VIRTUAL（合并 ALIPAY/WECHAT）、INVESTMENT、INSURANCE、DEBT
--   旧的 ALIPAY/WECHAT 自动迁移到 VIRTUAL
--   旧值保留在 enum 中以兼容历史读取（Postgres 不支持干净地 DROP enum value）

-- 1. 新增 enum 值（必须独立提交才能 UPDATE 使用，所以这里直接 ADD）
ALTER TYPE "AccountType" ADD VALUE IF NOT EXISTS 'VIRTUAL';
ALTER TYPE "AccountType" ADD VALUE IF NOT EXISTS 'INVESTMENT';
ALTER TYPE "AccountType" ADD VALUE IF NOT EXISTS 'INSURANCE';
ALTER TYPE "AccountType" ADD VALUE IF NOT EXISTS 'DEBT';

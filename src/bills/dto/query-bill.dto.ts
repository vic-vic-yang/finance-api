import { IsOptional, IsEnum, IsString, IsNumber, IsDateString, IsInt, Min, Max, Matches } from 'class-validator';
import { Type } from 'class-transformer';

export class QueryBillDto {
  @IsOptional()
  @IsEnum(['day', 'week', 'month', 'quarter', 'year'])
  groupBy?: 'day' | 'week' | 'month' | 'quarter' | 'year';

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @IsDateString()
  beforeGroup?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(-840)
  @Max(840)
  timezoneOffset?: number = 480;

  @IsOptional()
  @IsDateString()
  startAt?: string;

  @IsOptional()
  @IsDateString()
  endBefore?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  limit?: number = 20;

  @IsOptional()
  @IsEnum(['income', 'expense'])
  type?: 'income' | 'expense';

  /// 'true' = 只看转账；'false' = 排除转账；缺省 = 全部。
  /// 注意：传了 type（筛收入/支出）时自动排除转账腿——转账不算收支。
  @IsOptional()
  @IsString()
  isTransfer?: string;

  /// 按来源过滤（如 'stock' 只看股票盈亏）；另注意：传了 type 时自动排除 source='stock'
  @IsOptional()
  @IsString()
  source?: string;

  /// 'true' 时列表包含股票纸面盈亏（账户详情余额轨迹用）；
  /// 缺省排除——未卖出的纸面盈亏不是真收支，不出现在账单列表
  @IsOptional()
  @IsString()
  includeStock?: string;

  @IsOptional()
  @IsString()
  categoryId?: string;

  /// 多分类筛选：逗号分隔的分类 id 列表（与 categoryId 二选一，优先本字段）
  @IsOptional()
  @IsString()
  categoryIds?: string;

  /// 多账户筛选：逗号分隔
  @IsOptional()
  @IsString()
  accountIds?: string;

  /// 多记账人筛选：逗号分隔
  @IsOptional()
  @IsString()
  userIds?: string;

  @IsOptional()
  @IsString()
  accountId?: string;

  /// 按记账人筛选（共享账本里区分谁记的）
  @IsOptional()
  @IsString()
  userId?: string;

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;

  /// 金额范围（含边界）
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  minAmount?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  maxAmount?: number;
}

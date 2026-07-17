import { IsOptional, IsEnum, IsString, IsNumber, IsDateString } from 'class-validator';
import { Type } from 'class-transformer';

export class QueryBillDto {
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

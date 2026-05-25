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
}

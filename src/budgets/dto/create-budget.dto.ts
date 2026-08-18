import { IsString, IsNumber, IsEnum, IsOptional, IsDateString, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateBudgetDto {
  @IsOptional()
  @IsString()
  categoryId?: string;

  @Type(() => Number)
  @IsNumber()
  @Min(0.01, { message: '预算金额必须大于0' })
  amount: number;

  @IsEnum(['MONTHLY', 'YEARLY'], { message: '周期只能是 MONTHLY 或 YEARLY' })
  period: 'MONTHLY' | 'YEARLY';

  @IsDateString()
  startDate: string;

  @IsOptional()
  @IsString()
  ownerId?: string;
}

import { IsString, IsNumber, IsEnum, IsOptional, IsDateString, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateBillDto {
  @IsEnum(['income', 'expense'], { message: '类型只能是 income 或 expense' })
  type: 'income' | 'expense';

  @Type(() => Number)
  @IsNumber({}, { message: '金额必须是数字' })
  @Min(0.01, { message: '金额必须大于0' })
  amount: number;

  @IsString()
  categoryId: string;

  @IsString()
  accountId: string;

  @IsOptional()
  @IsString()
  note?: string;

  @IsOptional()
  @IsDateString()
  date?: string;
}

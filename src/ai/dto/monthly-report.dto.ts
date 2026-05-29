import {
  IsString, IsNumber, IsInt, IsOptional, IsArray, ValidateNested,
  Min, Max,
} from 'class-validator';
import { Type } from 'class-transformer';

class CategoryAggDto {
  @IsString() categoryId!: string;
  @IsString() name!: string;
  @IsNumber() @Min(0) amount!: number;
  @IsOptional() @IsInt() count?: number;
}

class MerchantAggDto {
  @IsString() merchant!: string;
  @IsNumber() @Min(0) amount!: number;
  @IsOptional() @IsInt() count?: number;
}

class WeekAggDto {
  @IsString() week!: string;
  @IsNumber() @Min(0) amount!: number;
}

class BudgetExecDto {
  @IsString() categoryName!: string;
  @IsNumber() @Min(0) used!: number;
  @IsNumber() @Min(0) limit!: number;
}

class PeriodDto {
  @IsInt() @Min(2000) @Max(2100) year!: number;
  @IsInt() @Min(1) @Max(12) month!: number;
}

class AggregatesDto {
  @IsNumber() @Min(0) income!: number;
  @IsNumber() @Min(0) expense!: number;

  @IsArray() @ValidateNested({ each: true }) @Type(() => CategoryAggDto)
  byCategory!: CategoryAggDto[];

  @IsOptional()
  @IsArray() @ValidateNested({ each: true }) @Type(() => MerchantAggDto)
  byMerchant?: MerchantAggDto[];

  @IsOptional()
  @IsArray() @ValidateNested({ each: true }) @Type(() => WeekAggDto)
  byWeek?: WeekAggDto[];

  @IsOptional()
  @IsArray() @ValidateNested({ each: true }) @Type(() => BudgetExecDto)
  budgetExec?: BudgetExecDto[];
}

export class MonthlyReportDto {
  @IsString()
  ledgerId!: string;

  @ValidateNested() @Type(() => PeriodDto)
  period!: PeriodDto;

  @ValidateNested() @Type(() => AggregatesDto)
  aggregates!: AggregatesDto;
}

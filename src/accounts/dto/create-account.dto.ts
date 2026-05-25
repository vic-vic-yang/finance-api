import {
  IsString, IsEnum, IsOptional, IsNumber, IsInt,
  Min, Max, IsBoolean, IsDateString,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateAccountDto {
  @IsString()
  name: string;

  @IsEnum(
    [
      'CASH',
      'BANK',
      'VIRTUAL',
      'CREDIT',
      'INVESTMENT',
      'INSURANCE',
      'DEBT',
      'OTHER',
      // 历史值，已不再由 UI 选用，但接受以兼容老客户端
      'ALIPAY',
      'WECHAT',
    ],
    { message: '账户类型无效' },
  )
  type:
    | 'CASH'
    | 'BANK'
    | 'VIRTUAL'
    | 'CREDIT'
    | 'INVESTMENT'
    | 'INSURANCE'
    | 'DEBT'
    | 'OTHER'
    | 'ALIPAY'
    | 'WECHAT';

  /// 初始余额。允许负数（信用卡/负债账户欠款用负数表示）
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  initialBalance?: number;

  @IsOptional()
  @IsString()
  icon?: string;

  @IsOptional()
  @IsString()
  color?: string;

  /// true = 共享给账本所有成员；false（默认）= 仅自己可见
  @IsOptional()
  @IsBoolean()
  isShared?: boolean;

  // ─── 信用卡 ──────────────────────────────────────────────
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(31)
  statementDay?: number;

  /// 还款日（信用卡）/ 月还款日（负债账户）
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(31)
  dueDay?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  creditLimit?: number;

  // ─── 负债 ────────────────────────────────────────────────
  /// 年利率（百分比），如 5.4 表示 5.4%
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  interestRate?: number;

  /// 贷款本金（原始金额）
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  loanPrincipal?: number;

  /// 贷款期限（月）；通常 12 / 36 / 60 / 120 / 240 / 360
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(720)
  loanTermMonths?: number;

  /// 首次还款日期（ISO 字符串 YYYY-MM-DD）
  @IsOptional()
  @IsDateString()
  firstPaymentDate?: string;

  /// 还款方式：equal_payment / equal_principal / interest_only / lump_sum / flexible
  @IsOptional()
  @IsEnum(
    [
      'equal_payment',
      'equal_principal',
      'interest_only',
      'lump_sum',
      'flexible',
    ],
    { message: '还款方式不在允许列表内' },
  )
  repaymentMethod?:
    | 'equal_payment'
    | 'equal_principal'
    | 'interest_only'
    | 'lump_sum'
    | 'flexible';

  // ─── 自动入账（社保 / 公积金等）─────────────────────────
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(31)
  autoDepositDay?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  autoDepositAmount?: number;

  @IsOptional()
  @IsString()
  autoDepositCategoryId?: string;
}

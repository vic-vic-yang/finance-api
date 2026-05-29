import {
  IsString, IsNumber, IsInt, IsOptional, IsIn, IsBoolean, Min, Max,
} from 'class-validator';

export class CreateRecurringDto {
  @IsString()
  categoryId!: string;

  @IsString()
  accountId!: string;

  @IsOptional()
  @IsIn(['expense', 'income'])
  type?: 'expense' | 'income';

  @IsNumber()
  @Min(0.01)
  amount!: number;

  /** 备注密文 base64（同 Bill.noteCipher 格式），可空 */
  @IsOptional()
  @IsString()
  noteCipher?: string;

  @IsOptional()
  @IsInt()
  noteDekVer?: number;

  @IsIn(['monthly', 'weekly', 'yearly'])
  cycleType!: 'monthly' | 'weekly' | 'yearly';

  /** monthly: 1-31；weekly: 1-7；yearly: mmdd 如 0815 → 815 */
  @IsInt()
  @Min(1)
  @Max(1231)
  cycleDay!: number;

  /** 默认 true */
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  /** 由 AI 候选确认入库时带，普通手动添加不传 */
  @IsOptional()
  @IsBoolean()
  isAuto?: boolean;

  @IsOptional()
  @IsNumber()
  confidence?: number;
}

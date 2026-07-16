import { Type } from 'class-transformer';
import {
  IsArray,
  IsBase64,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

export class ApplyBillItemDto {
  @IsString()
  accountId: string;

  @IsString()
  categoryId: string;

  @IsEnum(['expense', 'income'])
  type: 'expense' | 'income';

  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  amount: number;

  @IsBase64()
  noteCipher: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  noteDekVer: number;

  @IsDateString()
  date: string;

  /** 平台交易订单号，用于同源去重；可空 */
  @IsString()
  @IsOptional()
  externalId?: string;

  /** 来源渠道：alipay / wechat / bank / manual */
  @IsString()
  @IsOptional()
  source?: string;

  /** 是否为转账拆分出的账单（一收一支）；转账不计入收支统计 */
  @IsBoolean()
  @IsOptional()
  isTransfer?: boolean;

  /** 银行联机余额（该笔后余额）；用于高精度去重 + 校准账户余额 */
  @Type(() => Number)
  @IsNumber()
  @IsOptional()
  bankBalance?: number;

  /** 商户名哈希（服务端解析时算好、客户端原样回传）；分类纠正记忆用 */
  @IsString()
  @IsOptional()
  merchantHash?: string;
}

export class ApplyTransferItemDto {
  @IsString()
  fromAccountId: string;

  @IsString()
  toAccountId: string;

  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  amount: number;
}

/** 导入时被归类为「借贷」的行 → 进借贷往来（借出=应收 / 借入=应付） */
export class ApplyLoanItemDto {
  @IsEnum(['lend', 'borrow'])
  direction: 'lend' | 'borrow';

  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  amount: number;

  @IsString()
  accountId: string;

  /** 备注密文（base64），如"借给羊小斌" */
  @IsString()
  @IsOptional()
  noteCipher?: string;

  @Type(() => Number)
  @IsInt()
  @IsOptional()
  noteDekVer?: number;

  @IsDateString()
  date: string;
}

export class ApplyImportDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ApplyBillItemDto)
  bills: ApplyBillItemDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ApplyTransferItemDto)
  transfers?: ApplyTransferItemDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ApplyLoanItemDto)
  loans?: ApplyLoanItemDto[];
}

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
}

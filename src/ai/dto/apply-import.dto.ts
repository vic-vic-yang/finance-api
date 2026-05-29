import { Type } from 'class-transformer';
import {
  IsArray,
  IsBase64,
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
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
}

export class ApplyImportDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ApplyBillItemDto)
  bills: ApplyBillItemDto[];
}

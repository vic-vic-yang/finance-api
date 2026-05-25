import {
  IsString,
  IsNumber,
  IsEnum,
  IsOptional,
  IsDateString,
  IsBase64,
  IsInt,
  Min,
} from 'class-validator';
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

  /** 备注密文（SM4(DEK, iv) ‖ ct ‖ mac），base64。空备注也必须加密一个固定 placeholder */
  @IsBase64()
  noteCipher: string;

  /** 加密所用 DEK 版本 */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  noteDekVer: number;

  @IsOptional()
  @IsDateString()
  date?: string;
}

import {
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

export class CreateLoanDto {
  @IsIn(['lend', 'borrow'])
  direction: string; // lend=借出(应收) borrow=借入(应付)

  @IsNumber()
  @Min(0.01)
  amount: number;

  @IsOptional()
  @IsString()
  accountId?: string;

  @IsOptional()
  @IsString()
  noteCipher?: string; // base64

  @IsOptional()
  @IsNumber()
  noteDekVer?: number;

  @IsOptional()
  @IsString()
  voucherKey?: string;

  @IsOptional()
  @IsString()
  date?: string; // ISO
}

export class RepayLoanDto {
  @IsNumber()
  @Min(0.01)
  amount: number;

  @IsOptional()
  @IsString()
  accountId?: string;

  @IsOptional()
  @IsString()
  noteCipher?: string;

  @IsOptional()
  @IsNumber()
  noteDekVer?: number;
}

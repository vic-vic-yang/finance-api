import { IsIn, IsNumber, IsOptional, IsString } from 'class-validator';

/** 把一条普通账单「转为借贷」或「转为账户间转账」（原地重分类，不重复扣钱） */
export class ConvertBillDto {
  @IsIn(['loan', 'transfer'])
  to: 'loan' | 'transfer';

  /** to=transfer 时：对端账户（钱去/来的另一个账本内账户） */
  @IsString()
  @IsOptional()
  toAccountId?: string;

  /** to=loan 时：可覆盖备注（如"借给羊小斌"）；不传则沿用原账单备注 */
  @IsString()
  @IsOptional()
  noteCipher?: string;

  @IsNumber()
  @IsOptional()
  noteDekVer?: number;
}

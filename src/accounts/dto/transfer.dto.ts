import { IsString, IsNotEmpty, IsNumber, Min, IsOptional } from 'class-validator';

export class TransferDto {
  @IsString()
  @IsNotEmpty({ message: '转出账户不能为空' })
  fromAccountId: string;

  @IsString()
  @IsNotEmpty({ message: '转入账户不能为空' })
  toAccountId: string;

  @IsNumber({ maxDecimalPlaces: 2 }, { message: '金额必须是数字' })
  @Min(0.01, { message: '转账金额必须大于 0' })
  amount: number;

  @IsString()
  @IsOptional()
  note?: string;
}

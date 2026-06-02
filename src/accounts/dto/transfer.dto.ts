import {
  IsString,
  IsNotEmpty,
  IsNumber,
  Min,
  IsOptional,
  IsBase64,
  IsInt,
} from 'class-validator';

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

  // ── 转账轨迹流水（可选）──────────────────────────────
  // 客户端用账本 DEK 加密好的备注密文；提供时服务端会各生成一条
  // isTransfer 账单（转出 expense / 转入 income），便于查询轨迹、不进收支统计。
  @IsBase64()
  @IsOptional()
  fromNoteCipher?: string;

  @IsBase64()
  @IsOptional()
  toNoteCipher?: string;

  @IsInt()
  @IsOptional()
  noteDekVer?: number;
}

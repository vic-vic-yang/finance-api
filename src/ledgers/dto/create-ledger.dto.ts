import {
  IsString,
  IsNotEmpty,
  MaxLength,
  IsOptional,
  IsBase64,
} from 'class-validator';

export class CreateLedgerDto {
  @IsString()
  @IsNotEmpty({ message: '账本名称不能为空' })
  @MaxLength(20, { message: '账本名称最长 20 字符' })
  name: string;

  @IsString()
  @IsOptional()
  icon?: string;

  /** 本账本的 DEK，用创建者自己的 SM2 公钥包装后的字节流（base64） */
  @IsBase64()
  dekWrapped: string;
}

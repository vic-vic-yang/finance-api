import { IsString, IsNotEmpty, MaxLength, IsOptional } from 'class-validator';

export class CreateLedgerDto {
  @IsString()
  @IsNotEmpty({ message: '账本名称不能为空' })
  @MaxLength(20, { message: '账本名称最长 20 字符' })
  name: string;

  @IsString()
  @IsOptional()
  icon?: string;
}

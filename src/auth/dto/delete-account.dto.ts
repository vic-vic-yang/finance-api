import { IsString, MinLength } from 'class-validator';

export class DeleteAccountDto {
  @IsString()
  @MinLength(1, { message: '请输入当前密码' })
  password: string;
}

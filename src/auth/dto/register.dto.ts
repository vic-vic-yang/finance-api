import { IsString, MinLength, MaxLength } from 'class-validator';

export class RegisterDto {
  @IsString()
  @MinLength(2, { message: '用户名至少2个字符' })
  @MaxLength(20, { message: '用户名最多20个字符' })
  username: string;

  @IsString()
  @MinLength(6, { message: '密码至少6个字符' })
  password: string;
}

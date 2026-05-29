import { IsBase64, IsString, MinLength } from 'class-validator';

export class ChangePasswordDto {
  @IsString()
  oldPassword: string;

  @IsString()
  @MinLength(6, { message: '新密码至少 6 个字符' })
  newPassword: string;

  /** 客户端用 PBKDF2(newPassword, kdfSalt) 重新加密的 SM2 私钥 */
  @IsBase64()
  sm2PrivByPwd: string;
}

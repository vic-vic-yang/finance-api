import { IsBase64, IsString, MinLength, IsNotEmpty } from 'class-validator';

/// 第二步：恢复码验证通过 → 改 bcrypt 密码 + 改 sm2PrivByPwd
export class RecoverFinishDto {
  @IsString()
  @IsNotEmpty()
  username: string;

  /// 用户输入的恢复码原文（服务端 SM3(code || salt) 比对 recoveryHash）
  @IsString()
  @IsNotEmpty()
  recoveryCode: string;

  @IsString()
  @MinLength(6, { message: '新密码至少 6 个字符' })
  newPassword: string;

  /// 客户端用 PBKDF2(newPassword, kdfSalt) 重新加密的 SM2 私钥
  @IsBase64()
  sm2PrivByPwd: string;
}

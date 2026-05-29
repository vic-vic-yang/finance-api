import { IsString, IsNotEmpty } from 'class-validator';

/// 第一步：拿到用户的 salt 和恢复码加密的 privKey 密文
/// 不需要登录；服务端按 username 查（暴露 username 是否存在的信号 ≈ 登录页本来就有）
export class RecoverStartDto {
  @IsString()
  @IsNotEmpty()
  username: string;
}

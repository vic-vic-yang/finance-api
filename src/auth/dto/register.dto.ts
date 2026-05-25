import {
  IsString,
  MinLength,
  MaxLength,
  IsBase64,
  IsHexadecimal,
  Length,
} from 'class-validator';

/**
 * 注册请求体。
 *
 * 客户端在 POST 前已经做了：
 *  1. 生成 SM2 密钥对（sm2PubKey + 私钥）
 *  2. 生成 16 字节恢复码 + 16 字节 kdfSalt
 *  3. KDF(密码, salt) → KEK1；KDF(恢复码, salt) → KEK2
 *  4. SM4 用 KEK1 加密私钥 → sm2PrivByPwd
 *  5. SM4 用 KEK2 加密私钥 → sm2PrivByRecovery
 *  6. SM3(恢复码 || salt) → recoveryHash
 *  7. 为自己的"个人账本"生成 16 字节 DEK，用 sm2PubKey SM2 包装 → personalLedgerDekWrapped
 *
 * 服务端只校验 + 落库，永不解任何密钥。
 */
export class RegisterDto {
  @IsString()
  @MinLength(2, { message: '用户名至少2个字符' })
  @MaxLength(20, { message: '用户名最多20个字符' })
  username: string;

  @IsString()
  @MinLength(6, { message: '密码至少6个字符' })
  password: string;

  /** SM2 公钥，hex（130 char：04 || x(64) || y(64)） */
  @IsString()
  @IsHexadecimal()
  @Length(130, 130, { message: 'SM2 公钥长度必须是 130 hex 字符' })
  sm2PubKey: string;

  /** SM2 私钥用 KDF(密码) 加密后的字节流，base64 */
  @IsBase64()
  sm2PrivByPwd: string;

  /** SM2 私钥用 KDF(恢复码) 加密后的字节流，base64 */
  @IsBase64()
  sm2PrivByRecovery: string;

  /** KDF salt，base64（16 字节） */
  @IsBase64()
  kdfSalt: string;

  /** 恢复码 SM3 哈希，base64（32 字节） */
  @IsBase64()
  recoveryHash: string;

  /** 个人账本的 DEK，用 sm2PubKey SM2 加密后的字节流，base64 */
  @IsBase64()
  personalLedgerDekWrapped: string;
}

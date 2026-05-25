import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SmService } from './sm.service';

/**
 * KMS（密钥管理服务）：
 *  - 主密钥 KEK 从环境变量 SM_KEK 注入（应放生产环境的 KMS / Vault；本地 .env）
 *  - 只用 KEK 加密/解密其他短密钥（DEK 或 服务端兜底密钥），不直接加密业务数据
 *  - 提供"用 KEK 包装"和"用 KEK 解包"两个 API，供 ledger DEK 兜底等场景
 *
 * 当前架构下 KEK 主要场景：
 *   - 服务端不持有用户私钥；用户私钥靠密码 + 恢复码 双重派生 KEK 加密后存 DB
 *   - 但 KEK 仍可用于：会话级敏感数据兜底加密、备份导出等
 */
@Injectable()
export class KmsService implements OnModuleInit {
  private readonly logger = new Logger(KmsService.name);
  private kek!: Buffer;

  constructor(
    private readonly config: ConfigService,
    private readonly sm: SmService,
  ) {}

  onModuleInit() {
    const hex = this.config.get<string>('SM_KEK');
    if (!hex) {
      // 开发模式自动派生一个固定 KEK（仅用于本地）—— 生产必须设置 SM_KEK
      this.logger.warn(
        '⚠️ 未设置 SM_KEK 环境变量，使用开发默认 KEK；生产请改为强随机 32 字节十六进制',
      );
      this.kek = this.sm.sm3(Buffer.from('finance-app-dev-kek-do-not-use-in-prod')).subarray(0, 16);
      return;
    }
    const buf = Buffer.from(hex, 'hex');
    if (buf.length !== 16) {
      throw new Error('SM_KEK 必须是 16 字节十六进制（32 个 hex 字符）');
    }
    this.kek = buf;
    this.logger.log('✅ KMS 主密钥已加载');
  }

  /** 用 KEK 包装任意短密钥（最长 < 4KB） */
  wrap(key: Buffer): Buffer {
    return this.sm.sm4Encrypt(key, this.kek);
  }

  unwrap(wrapped: Buffer): Buffer {
    return this.sm.sm4Decrypt(wrapped, this.kek);
  }
}

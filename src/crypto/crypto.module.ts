import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { SmService } from './sm.service';
import { KmsService } from './kms.service';

/**
 * 全局加密模块。
 *  - SmService 提供国密原语
 *  - KmsService 持有主密钥 KEK
 *
 * 设为 @Global，业务模块直接 inject 即可，无需 import。
 */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [SmService, KmsService],
  exports: [SmService, KmsService],
})
export class CryptoModule {}

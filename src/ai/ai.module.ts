import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LedgersModule } from '../ledgers/ledgers.module';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { ChatService } from './chat.service';
import { LlmRegistry } from './llm/llm-registry';

@Module({
  imports: [ConfigModule, LedgersModule],
  controllers: [AiController],
  providers: [AiService, ChatService, LlmRegistry],
  exports: [AiService, ChatService, LlmRegistry],
})
export class AiModule {}

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';
import { AiModule } from '../ai/ai.module';
import { NewsController } from './news.controller';
import { NewsService } from './news.service';

@Module({
  // AiModule 导出 LlmRegistry，复用同一套 LLM 配置
  imports: [ConfigModule, PrismaModule, AiModule],
  controllers: [NewsController],
  providers: [NewsService],
})
export class NewsModule {}

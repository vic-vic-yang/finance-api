import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ToolsController } from './tools.controller';
import { ExchangeService } from './exchange.service';
import { StockService } from './stock.service';

@Module({
  imports: [AiModule, PrismaModule], // LlmRegistry（解析+分析）+ 股票快照持久化
  controllers: [ToolsController],
  providers: [ExchangeService, StockService],
})
export class ToolsModule {}

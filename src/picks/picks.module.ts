import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AiModule } from '../ai/ai.module';
import { PicksController } from './picks.controller';
import { PicksService } from './picks.service';
import { MarketDataService } from './market-data.service';

@Module({
  imports: [PrismaModule, AiModule], // AiModule 导出 LlmRegistry
  controllers: [PicksController],
  providers: [PicksService, MarketDataService],
})
export class PicksModule {}

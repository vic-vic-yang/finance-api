import { Module } from '@nestjs/common';
import { BriefingController } from './briefing.controller';
import { BriefingService } from './briefing.service';
import { BriefingScheduler } from './briefing.scheduler';
import { LedgersModule } from '../ledgers/ledgers.module';
import { AiModule } from '../ai/ai.module';
import { HealthModule } from '../health/health.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  // AiModule 导出 LlmResolver（BYOK 三层解析）；NotificationsModule 导出 NotificationsService
  imports: [LedgersModule, AiModule, HealthModule, NotificationsModule],
  controllers: [BriefingController],
  providers: [BriefingService, BriefingScheduler],
  exports: [BriefingService],
})
export class BriefingModule {}

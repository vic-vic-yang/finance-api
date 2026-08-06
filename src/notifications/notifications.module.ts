import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { ProactiveScanService } from './proactive-scan.service';
import { CfoModule } from '../cfo/cfo.module';

@Module({
  imports: [CfoModule], // CfoModule 已导出 CfoService（含 generateNewProposals）
  controllers: [NotificationsController],
  providers: [NotificationsService, ProactiveScanService],
  exports: [NotificationsService],
})
export class NotificationsModule {}

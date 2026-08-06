import { Module } from '@nestjs/common';
import { ReconcileController } from './reconcile.controller';
import { ReconcileService } from './reconcile.service';
import { LedgersModule } from '../ledgers/ledgers.module';

@Module({
  imports: [LedgersModule],
  controllers: [ReconcileController],
  providers: [ReconcileService],
  exports: [ReconcileService],
})
export class ReconcileModule {}

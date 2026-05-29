import { Module } from '@nestjs/common';
import { RecurringController } from './recurring.controller';
import { RecurringService } from './recurring.service';
import { LedgersModule } from '../ledgers/ledgers.module';

@Module({
  imports: [LedgersModule],
  controllers: [RecurringController],
  providers: [RecurringService],
  exports: [RecurringService],
})
export class RecurringModule {}

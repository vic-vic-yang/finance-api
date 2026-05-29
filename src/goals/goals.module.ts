import { Module } from '@nestjs/common';
import { GoalsController } from './goals.controller';
import { GoalsService } from './goals.service';
import { LedgersModule } from '../ledgers/ledgers.module';

@Module({
  imports: [LedgersModule],
  controllers: [GoalsController],
  providers: [GoalsService],
})
export class GoalsModule {}

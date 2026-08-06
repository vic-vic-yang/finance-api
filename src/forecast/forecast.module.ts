import { Module } from '@nestjs/common';
import { ForecastController } from './forecast.controller';
import { ForecastService } from './forecast.service';
import { LedgersModule } from '../ledgers/ledgers.module';
import { GoalsModule } from '../goals/goals.module';

@Module({
  imports: [LedgersModule, GoalsModule],
  controllers: [ForecastController],
  providers: [ForecastService],
  exports: [ForecastService],
})
export class ForecastModule {}

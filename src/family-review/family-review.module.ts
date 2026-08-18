import { Module } from '@nestjs/common';
import { FamilyReviewController } from './family-review.controller';
import { FamilyReviewService } from './family-review.service';
import { LedgersModule } from '../ledgers/ledgers.module';
import { GoalsModule } from '../goals/goals.module';

@Module({
  imports: [LedgersModule, GoalsModule],
  controllers: [FamilyReviewController],
  providers: [FamilyReviewService],
})
export class FamilyReviewModule {}

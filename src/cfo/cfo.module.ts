import { Module } from '@nestjs/common';
import { CfoController } from './cfo.controller';
import { CfoService } from './cfo.service';
import { PrismaModule } from '../prisma/prisma.module';
import { BudgetsModule } from '../budgets/budgets.module';
import { GoalsModule } from '../goals/goals.module';
import { LedgersModule } from '../ledgers/ledgers.module';

@Module({
  imports: [PrismaModule, BudgetsModule, GoalsModule, LedgersModule],
  controllers: [CfoController],
  providers: [CfoService],
  exports: [CfoService],
})
export class CfoModule {}

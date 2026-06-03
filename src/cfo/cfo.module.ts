import { Module } from '@nestjs/common';
import { CfoController } from './cfo.controller';
import { CfoService } from './cfo.service';
import { PrismaModule } from '../prisma/prisma.module';
import { BudgetsModule } from '../budgets/budgets.module';
import { GoalsModule } from '../goals/goals.module';

@Module({
  imports: [PrismaModule, BudgetsModule, GoalsModule],
  controllers: [CfoController],
  providers: [CfoService],
})
export class CfoModule {}

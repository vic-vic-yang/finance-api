import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LedgersModule } from '../ledgers/ledgers.module';
import { AccountsModule } from '../accounts/accounts.module';
import { CfoModule } from '../cfo/cfo.module';
import { LoansModule } from '../loans/loans.module';
import { ForecastModule } from '../forecast/forecast.module';
import { HealthModule } from '../health/health.module';
import { InsightsModule } from '../insights/insights.module';
import { RecurringModule } from '../recurring/recurring.module';
import { ReconcileModule } from '../reconcile/reconcile.module';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { ChatService } from './chat.service';
import { LlmRegistry } from './llm/llm-registry';
import { LlmResolver } from './llm/llm-resolver';

@Module({
  imports: [
    ConfigModule,
    LedgersModule,
    AccountsModule,
    CfoModule,
    LoansModule,
    ForecastModule,
    HealthModule,
    InsightsModule,
    RecurringModule,
    ReconcileModule,
  ],
  controllers: [AiController],
  providers: [AiService, ChatService, LlmRegistry, LlmResolver],
  exports: [AiService, ChatService, LlmRegistry, LlmResolver],
})
export class AiModule {}

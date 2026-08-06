import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { APP_GUARD } from '@nestjs/core';
import { PrismaModule } from './prisma/prisma.module';
import { CryptoModule } from './crypto/crypto.module';
import { AuthModule } from './auth/auth.module';
import { AccountsModule } from './accounts/accounts.module';
import { CategoriesModule } from './categories/categories.module';
import { BillsModule } from './bills/bills.module';
import { BudgetsModule } from './budgets/budgets.module';
import { StatsModule } from './stats/stats.module';
import { LedgersModule } from './ledgers/ledgers.module';
import { AiModule } from './ai/ai.module';
import { RecurringModule } from './recurring/recurring.module';
import { InsightsModule } from './insights/insights.module';
import { GoalsModule } from './goals/goals.module';
import { CfoModule } from './cfo/cfo.module';
import { ToolsModule } from './tools/tools.module';
import { AppUpdateModule } from './app-update/app-update.module';
import { LoansModule } from './loans/loans.module';
import { AdminModule } from './admin/admin.module';
import { UploadsModule } from './uploads/uploads.module';
import { ForecastModule } from './forecast/forecast.module';
import { NotificationsModule } from './notifications/notifications.module';
import { ReconcileModule } from './reconcile/reconcile.module';
import { HealthModule } from './health/health.module';
import { BriefingModule } from './briefing/briefing.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // 全局限流：每 IP 每 60 秒 60 次（防爆破/刷接口）
    // 登录/注册在 auth.controller.ts 用 @Throttle 单独收紧
    ThrottlerModule.forRoot([
      { name: 'default', ttl: 60_000, limit: 60 },
    ]),
    ScheduleModule.forRoot(),
    PrismaModule,
    CryptoModule,
    AuthModule,
    AccountsModule,
    CategoriesModule,
    BillsModule,
    BudgetsModule,
    StatsModule,
    LedgersModule,
    AiModule,
    RecurringModule,
    InsightsModule,
    GoalsModule,
    CfoModule,
    ToolsModule,
    AppUpdateModule,
    LoansModule,
    AdminModule,
    UploadsModule,
    ForecastModule,
    NotificationsModule,
    ReconcileModule,
    HealthModule,
    BriefingModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}

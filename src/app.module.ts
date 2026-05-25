import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { AccountsModule } from './accounts/accounts.module';
import { CategoriesModule } from './categories/categories.module';
import { BillsModule } from './bills/bills.module';
import { BudgetsModule } from './budgets/budgets.module';
import { StatsModule } from './stats/stats.module';
import { LedgersModule } from './ledgers/ledgers.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // 全局限流：每 IP 每 60 秒 60 次（防爆破/刷接口）
    // 登录/注册在 auth.controller.ts 用 @Throttle 单独收紧
    ThrottlerModule.forRoot([
      { name: 'default', ttl: 60_000, limit: 60 },
    ]),
    PrismaModule,
    AuthModule,
    AccountsModule,
    CategoriesModule,
    BillsModule,
    BudgetsModule,
    StatsModule,
    LedgersModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}

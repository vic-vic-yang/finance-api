import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LedgersService } from '../ledgers/ledgers.service';
import { GoalsService } from '../goals/goals.service';
import {
  monthEndNetWorth,
  monthlyPatternForecast,
  detectRecurringIncome,
  recurringNetBetween,
  expensePace,
  goalEtaDate,
  buildForecastAttribution,
  IncomeBillLike,
  RecurringLike,
} from './forecast.calc';

/**
 * 现金流预测（GET /api/forecast）。
 *
 * 只用服务端明文字段（amount / date / balance / nextDate / 预算 / 目标金额），
 * 不触碰任何加密字段明文；周期账单备注与目标名称以密文透传，
 * 由客户端用账本 DEK 解密（隐私不变式与 cfo / insights 一致）。
 *
 * 收支统计口径：isTransfer = false 且 source != 'stock'
 * （账户互转与股票纸面盈亏都不是现金流）。
 */
@Injectable()
export class ForecastService {
  constructor(
    private prisma: PrismaService,
    private ledgers: LedgersService,
    private goals: GoalsService,
  ) {}

  async getForecast(userId: string, ledgerId: string) {
    await this.ledgers.ensureMembership(userId, ledgerId);

    const now = new Date();

    // ── 时间窗（均按服务器本地时区的自然月） ──────────────────
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEnd = new Date(
      now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999,
    );
    const daysInMonth = monthEnd.getDate();
    const daysElapsed = now.getDate();
    const remainingDays = daysInMonth - daysElapsed;

    const thirtyDaysAgo = new Date(now.getTime() - 30 * 86_400_000);
    const ninetyDaysAgo = new Date(now.getTime() - 90 * 86_400_000);
    const in30Days = new Date(now.getTime() + 30 * 86_400_000);

    // 上月同期窗口：上月 1 号 → 上月「今天对应日」（超出上月天数则取月末）
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMonthDays = new Date(
      now.getFullYear(), now.getMonth(), 0,
    ).getDate();
    const lastMonthSameDayEnd = new Date(
      now.getFullYear(), now.getMonth() - 1,
      Math.min(daysElapsed, lastMonthDays), 23, 59, 59, 999,
    );

    /** 真收支口径的区间合计（收入 / 支出），缺省 0 */
    const sumOf = (type: 'income' | 'expense', gte: Date, lte: Date) =>
      this.prisma.bill
        .aggregate({
          where: {
            ledgerId,
            type,
            isTransfer: false,
            source: { not: 'stock' },
            date: { gte, lte },
          },
          _sum: { amount: true },
        })
        .then((r) => r._sum.amount ?? new Prisma.Decimal(0));

    const [
      accounts,
      loanRows,
      inc30,
      exp30,
      inc90,
      exp90,
      monthToDateIncome,
      monthToDateExpense,
      lastMonthSamePeriodExpense,
      incomeBills,
      prevMonths,
      budget,
      recurring,
      goalsRes,
    ] = await Promise.all([
      // 净资产口径：与统计页「资产汇总」一致——账本下全部账户（家庭口径），
      // 再 + 债权（借出未收）− 负债（借入未还）
      this.prisma.account.findMany({
        where: { ledgerId },
        select: { balance: true },
      }),
      this.prisma.loan.findMany({
        where: { ledgerId, settledAt: null },
        select: { direction: true, amount: true, repaidAmount: true },
      }),
      sumOf('income', thirtyDaysAgo, now),
      sumOf('expense', thirtyDaysAgo, now),
      sumOf('income', ninetyDaysAgo, now),
      sumOf('expense', ninetyDaysAgo, now),
      sumOf('income', monthStart, now),
      sumOf('expense', monthStart, now),
      sumOf('expense', lastMonthStart, lastMonthSameDayEnd),
      // 收入明细（近 3 个完整月 + 本月至今）：固定收入识别用，只用明文字段
      this.prisma.bill.findMany({
        where: {
          ledgerId,
          type: 'income',
          isTransfer: false,
          source: { not: 'stock' },
          date: {
            gte: new Date(now.getFullYear(), now.getMonth() - 3, 1),
            lte: now,
          },
        },
        select: { amount: true, date: true, categoryId: true },
      }),
      // 近 3 个完整自然月的收入 / 支出（月度模式预测的历史基线）
      Promise.all(
        [1, 2, 3].map(async (k) => {
          const s = new Date(now.getFullYear(), now.getMonth() - k, 1);
          const e = new Date(
            now.getFullYear(), now.getMonth() - k + 1, 0, 23, 59, 59, 999,
          );
          return {
            income: await sumOf('income', s, e),
            expense: await sumOf('expense', s, e),
          };
        }),
      ),
      // 当月总预算（categoryId 为 null 的 MONTHLY 预算；多条取最新）
      this.prisma.budget.findFirst({
        where: { ledgerId, categoryId: null, period: 'MONTHLY' },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.recurringBill.findMany({
        where: { ledgerId, isActive: true },
        orderBy: { nextDate: 'asc' },
      }),
      // 复用 goals 服务的进度口径（绑定账户用余额 / 未绑定用收支净额）
      this.goals.findAll(userId, ledgerId),
    ]);

    // ── 1) 月末净资产预测 ─────────────────────────────────────
    // 净资产 = 全部账户余额 + 债权（借出未收）− 负债（借入未还），同统计页
    let loanNet = new Prisma.Decimal(0);
    for (const l of loanRows) {
      const out = Prisma.Decimal.max(
        0,
        new Prisma.Decimal(l.amount).minus(l.repaidAmount),
      );
      loanNet = l.direction === 'lend' ? loanNet.plus(out) : loanNet.minus(out);
    }
    const currentNetWorth = accounts
      .reduce((s, a) => s.plus(a.balance), new Prisma.Decimal(0))
      .plus(loanNet);
    const avgDailyNetInflow = inc30.minus(exp30).div(30);
    // 口径：recurring 表 nextDate 落在本月内的（含月初以来已到期未生成的）
    const remainingRecurringNet = recurringNetBetween(
      recurring as RecurringLike[],
      monthStart,
      monthEnd,
    );
    // 历史基线：近 3 个完整月里「有流水的月份」的月均收支
    // （记了几个月就按几个月平均，最多取前 3 个月，避免空月稀释）
    const zero = new Prisma.Decimal(0);
    const sum3 = (pick: (m: (typeof prevMonths)[number]) => Prisma.Decimal) =>
      prevMonths.reduce((s, m) => s.plus(pick(m)), zero);
    const monthsSampled = prevMonths.filter(
      (m) => m.income.plus(m.expense).gt(0),
    ).length;
    const divBy = Math.max(1, monthsSampled);
    const avgMonthlyIncome = sum3((m) => m.income).div(divBy);
    const avgMonthlyExpense = sum3((m) => m.expense).div(divBy);
    // 主算法：月度收支模式；无完整月样本（新用户）回退旧日均法
    const method = monthsSampled > 0 ? 'monthly' : 'daily';
    let projected: Prisma.Decimal;
    let remainingIncome: Prisma.Decimal | null = null;
    let remainingExpense: Prisma.Decimal | null = null;
    if (method === 'monthly') {
      // 固定收入识别：把收入明细按完整月分桶 + 本月桶
      const toLike = (b: (typeof incomeBills)[number]): IncomeBillLike => ({
        amount: b.amount,
        dayOfMonth: b.date.getDate(),
        categoryId: b.categoryId,
      });
      const prevBuckets: IncomeBillLike[][] = [1, 2, 3].map((k) =>
        incomeBills
          .filter((b) => {
            const off =
              (now.getFullYear() - b.date.getFullYear()) * 12 +
              (now.getMonth() - b.date.getMonth());
            return off === k;
          })
          .map(toLike),
      );
      const thisMonthBills = incomeBills
        .filter((b) => {
          const off =
            (now.getFullYear() - b.date.getFullYear()) * 12 +
            (now.getMonth() - b.date.getMonth());
          return off === 0;
        })
        .map(toLike);
      // 有 ≥2 个完整月样本时按「固定收入项是否到账」预测，更贴近
      // 「每月就固定几笔收入」的真实形态；单个月样本退化为月均法
      const recurring =
        monthsSampled >= 2
          ? detectRecurringIncome(prevBuckets, thisMonthBills)
          : null;
      const r = monthlyPatternForecast({
        currentNetWorth,
        mtdIncome: monthToDateIncome,
        mtdExpense: monthToDateExpense,
        avgMonthlyIncome,
        avgMonthlyExpense,
        daysElapsed,
        remainingDays,
        expectedRemainingIncome: recurring?.expectedRemaining,
      });
      projected = r.projected;
      remainingIncome = r.remainingIncome;
      remainingExpense = r.remainingExpense;
    } else {
      projected = monthEndNetWorth({
        currentNetWorth,
        avgDailyNetInflow,
        remainingDays,
        remainingRecurringNet,
      });
    }

    // ── 1.5) 归因：预测由哪些驱动项构成（解释优先，各驱动项之和 == projected） ──
    const attribution = buildForecastAttribution({
      method,
      currentNetWorth,
      remainingIncome: remainingIncome ?? new Prisma.Decimal(0),
      remainingExpense: remainingExpense ?? new Prisma.Decimal(0),
      dailyNetInflow: avgDailyNetInflow.mul(remainingDays),
      remainingRecurringNet,
    }).map((a) => ({
      key: a.key,
      label: a.label,
      amount: Number(a.amount.toDecimalPlaces(2)),
    }));

    // ── 2) 未来 30 天周期扣款（含已到期未生成的，服务端只给明文+密文透传） ──
    const upcoming30 = recurring
      .filter((r) => r.nextDate.getTime() <= in30Days.getTime())
      .map((r) => ({
        id: r.id,
        categoryId: r.categoryId,
        accountId: r.accountId,
        type: r.type as 'income' | 'expense',
        amount: Number(r.amount),
        nextDate: r.nextDate.toISOString(),
        noteCipher: r.noteCipher
          ? Buffer.from(r.noteCipher).toString('base64')
          : null,
        noteDekVer: r.noteDekVer,
        cycleType: r.cycleType,
        cycleDay: r.cycleDay,
      }));

    // ── 3) 支出速率与超支预警 ─────────────────────────────────
    const pace = expensePace({
      monthToDateExpense,
      daysElapsed,
      daysInMonth,
      monthlyBudget: budget ? budget.amount : null,
    });

    // ── 4) 目标达成预测（近 90 天月均净存入） ──────────────────
    const monthlyRate = inc90.minus(exp90).div(3);
    const goalForecast = goalsRes.goals
      .filter((g) => !g.isCompleted)
      .map((g) => {
        const remaining = new Prisma.Decimal(g.targetAmount).minus(
          new Prisma.Decimal(g.currentSaved),
        );
        const eta = goalEtaDate({ remaining, monthlyRate, now });
        return {
          id: g.id,
          nameCipher: g.nameCipher,
          nameDekVer: g.nameDekVer,
          icon: g.icon,
          color: g.color,
          targetAmount: g.targetAmount,
          currentSaved: g.currentSaved,
          progress: g.progress,
          monthlyRate: Number(monthlyRate.toDecimalPlaces(2)),
          etaDate: eta ? eta.toISOString() : null,
        };
      });

    const r2 = (v: Prisma.Decimal) => Number(v.toDecimalPlaces(2));

    return {
      generatedAt: now.toISOString(),
      monthEndNetWorth: {
        current: r2(currentNetWorth),
        projected: r2(projected),
        method,
        monthsSampled,
        avgDailyNetInflow: r2(avgDailyNetInflow),
        remainingDays,
        daysInMonth,
        remainingRecurringNet: r2(remainingRecurringNet),
        mtdIncome: r2(monthToDateIncome),
        mtdExpense: r2(monthToDateExpense),
        avgMonthlyIncome: r2(avgMonthlyIncome),
        avgMonthlyExpense: r2(avgMonthlyExpense),
        remainingIncome: remainingIncome === null ? null : r2(remainingIncome),
        remainingExpense:
          remainingExpense === null ? null : r2(remainingExpense),
      },
      upcoming30,
      expensePace: {
        monthToDateExpense: r2(monthToDateExpense),
        lastMonthSamePeriodExpense: r2(lastMonthSamePeriodExpense),
        daysElapsed,
        daysInMonth,
        monthlyBudget: budget ? r2(budget.amount) : null,
        projectedMonthExpense: r2(pace.projectedMonthExpense),
        overspendRisk: pace.overspendRisk,
      },
      attribution,
      goalForecast,
    };
  }
}

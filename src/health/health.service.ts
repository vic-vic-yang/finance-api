import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LedgersService } from '../ledgers/ledgers.service';
import { BudgetUsage, scoreHealth } from './scorer';

/**
 * 财务健康评分（只读）。
 *
 * 数据口径（与 stats / budgets / reconcile 一致）：
 *  - 收支聚合一律过滤 isTransfer=false 且 source != 'stock'
 *    （前者排除转账双腿，后者排除股票纸面盈亏）。
 *  - 只消费明文字段（amount / date / type / balance / budget / loan），
 *    绝不读取 noteCipher / nameCipher。
 *  - 金额一律 Prisma.Decimal 运算，仅打分前一刻转 number。
 *  - 账户余额只合计「当前用户可见账户」（共享 + 本人私人），负债类账户
 *    （CREDIT 负余额 / DEBT）按 0 计，避免负债拉低应急金分子。
 */
@Injectable()
export class HealthService {
  constructor(
    private prisma: PrismaService,
    private ledgers: LedgersService,
  ) {}

  async score(userId: string, ledgerId: string) {
    await this.ledgers.ensureMembership(userId, ledgerId);

    const now = new Date();
    // 月界按服务器本地时区（与 reconcile / budgets 一致）
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    // 近 3 个完整月：上上月初 ~ 上月末
    const last3Start = new Date(now.getFullYear(), now.getMonth() - 3, 1, 0, 0, 0, 0);
    const last3End = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
    // 近 30 天（含今天）
    const streakStart = new Date(
      now.getFullYear(), now.getMonth(), now.getDate() - 29, 0, 0, 0, 0,
    );

    const [accounts, incExpAgg, monthCatAgg, budgets, categories, streakRows, borrowLoans] =
      await Promise.all([
        // 账户余额（含 ownerId / type 用于过滤），不取 nameCipher
        this.prisma.account.findMany({
          where: { ledgerId },
          select: { ownerId: true, type: true, balance: true },
        }),
        // 近 3 个完整月收支
        this.prisma.bill.groupBy({
          by: ['type'],
          where: {
            ledgerId,
            isTransfer: false,
            source: { not: 'stock' },
            date: { gte: last3Start, lte: last3End },
          },
          _sum: { amount: true },
        }),
        // 当月支出按分类聚合（预算已用计算用）
        this.prisma.bill.groupBy({
          by: ['categoryId'],
          where: {
            ledgerId,
            type: 'expense',
            isTransfer: false,
            source: { not: 'stock' },
            date: { gte: monthStart, lte: now },
          },
          _sum: { amount: true },
        }),
        // 当月预算纪律只看 MONTHLY 预算
        this.prisma.budget.findMany({
          where: { ledgerId, period: 'MONTHLY' },
          select: { categoryId: true, amount: true },
        }),
        // 分类父子关系（预算含子分类消耗，与 budgets.service 一致）
        this.prisma.category.findMany({
          where: { OR: [{ ledgerId }, { isSystem: true }] },
          select: { id: true, parentId: true },
        }),
        // 近 30 天账单日期（任意类型都算「记了账」），只取 date 明文字段
        this.prisma.bill.findMany({
          where: { ledgerId, date: { gte: streakStart, lte: now } },
          select: { date: true },
        }),
        // borrow 方向未结清借贷
        this.prisma.loan.findMany({
          where: { ledgerId, direction: 'borrow', settledAt: null },
          select: { amount: true, repaidAmount: true },
        }),
      ]);

    // ── 资产合计：可见账户；CREDIT 负余额 / DEBT 负债账户按 0 计 ──
    const zero = new Prisma.Decimal(0);
    const assetBalance = accounts
      .filter((a) => a.ownerId == null || a.ownerId === userId)
      .reduce((sum, a) => {
        if (a.type === 'DEBT') return sum; // 负债账户不计入资产
        if (a.type === 'CREDIT' && a.balance.lt(0)) return sum; // 信用卡欠款不抵减资产
        return sum.add(a.balance);
      }, zero);

    // ── 近 3 月收支 ──
    const sumOf = (type: string) =>
      incExpAgg.find((r) => r.type === type)?._sum.amount ?? zero;
    const last3Income = sumOf('income');
    const last3Expense = sumOf('expense');

    // ── 当月预算已用（含子分类；categoryId=null 为总预算） ──
    const usedByCat = new Map<string, Prisma.Decimal>();
    let monthExpenseTotal = new Prisma.Decimal(0);
    for (const r of monthCatAgg) {
      const amt = r._sum.amount ?? new Prisma.Decimal(0);
      usedByCat.set(r.categoryId, amt);
      monthExpenseTotal = monthExpenseTotal.add(amt);
    }
    const budgetUsage: BudgetUsage[] = budgets.map((b) => {
      if (!b.categoryId) return { amount: b.amount, used: monthExpenseTotal };
      const ids = new Set([b.categoryId]);
      for (const c of categories) {
        if (c.parentId === b.categoryId) ids.add(c.id);
      }
      let used = new Prisma.Decimal(0);
      for (const [cid, amt] of usedByCat) {
        if (ids.has(cid)) used = used.add(amt);
      }
      return { amount: b.amount, used };
    });

    // ── 记账坚持度：近 30 天有账单的本地日历天数 ──
    const dayKeys = new Set(
      streakRows.map(
        (r) => `${r.date.getFullYear()}-${r.date.getMonth()}-${r.date.getDate()}`,
      ),
    );
    const recordDays = Math.min(30, dayKeys.size);

    // ── 未还借款本金 ──
    const outstandingBorrow = borrowLoans.reduce((sum, l) => {
      const left = l.amount.minus(l.repaidAmount);
      return sum.add(left.gt(0) ? left : new Prisma.Decimal(0));
    }, zero);

    const result = scoreHealth({
      last3Income,
      last3Expense,
      budgets: budgetUsage,
      assetBalance,
      recordDays,
      outstandingBorrow,
    });

    return { ...result, computedAt: now };
  }
}

import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateBudgetDto } from './dto/create-budget.dto';
import { UpdateBudgetDto } from './dto/update-budget.dto';

@Injectable()
export class BudgetsService {
  constructor(private prisma: PrismaService) {}

  async findAll(ledgerId: string) {
    const budgets = await this.prisma.budget.findMany({
      where: { ledgerId },
      include: { category: true },
      orderBy: { createdAt: 'desc' },
    });

    const now = new Date();
    const enriched = await Promise.all(
      budgets.map(async (b) => {
        const [periodStart, periodEnd] = this.computePeriod(b.period, now);
        const [spent, members] = await Promise.all([
          this._spentOf(ledgerId, b.categoryId, periodStart, periodEnd),
          this._spentByMemberOf(ledgerId, b.categoryId, periodStart, periodEnd),
        ]);
        const amount = Number(b.amount);
        const remaining = amount - spent;
        const progress = amount > 0 ? Math.min(spent / amount, 999) : 0;
        return {
          ...this.serialize(b),
          spent,
          remaining,
          progress, // 0~1+，>1 表示超支
          periodStart: periodStart.toISOString(),
          periodEnd: periodEnd.toISOString(),
          // 共同预算：按记账人拆解（单人账本就一条，前端 ≥2 人才显示）
          members,
        };
      }),
    );
    return { budgets: enriched };
  }

  /** 某预算周期内按「记账人」拆解的支出（家庭共同预算：谁花了多少） */
  private async _spentByMemberOf(
    ledgerId: string,
    categoryId: string | null,
    start: Date,
    end: Date,
  ): Promise<{ userId: string; name: string; spent: number }[]> {
    const ids: string[] = [];
    if (categoryId) {
      ids.push(categoryId);
      const children = await this.prisma.category.findMany({
        where: { parentId: categoryId },
        select: { id: true },
      });
      ids.push(...children.map((c) => c.id));
    }
    const rows = await this.prisma.bill.groupBy({
      by: ['userId'],
      where: {
        ledgerId,
        type: 'expense',
        isTransfer: false,
        date: { gte: start, lte: end },
        ...(ids.length ? { categoryId: { in: ids } } : {}),
      },
      _sum: { amount: true },
    });
    if (rows.length === 0) return [];
    const users = await this.prisma.user.findMany({
      where: { id: { in: rows.map((r) => r.userId) } },
      select: { id: true, username: true, nickname: true },
    });
    const nameById = new Map(
      users.map((u) => [u.id, u.nickname || u.username]),
    );
    return rows
      .map((r) => ({
        userId: r.userId,
        name: nameById.get(r.userId) ?? '成员',
        spent: Number(r._sum.amount || 0),
      }))
      .sort((a, b) => b.spent - a.spent);
  }

  /**
   * 历史：返回最近 N 个周期的执行情况。
   *
   * 注意：因为我们没有为历史周期单独存预算（即"当时设的预算金额"），
   * 这里用 *当前* 的预算配置回看每个历史周期的实际开销。
   * 如果用户改过预算金额，旧数据会反映新预算。这是有意为之 —— 简单可靠，
   * 也是大多数记账 App 的常见做法。
   */
  async findHistory(
    ledgerId: string,
    period: 'MONTHLY' | 'YEARLY' = 'MONTHLY',
    count = 12,
  ) {
    const safeCount = Math.max(1, Math.min(count, 36));
    const budgets = await this.prisma.budget.findMany({
      where: { ledgerId, period, categoryId: { not: null } },
      include: { category: true },
    });

    const now = new Date();
    const periods: Array<{
      periodStart: string;
      periodEnd: string;
      label: string;
      totalBudget: number;
      totalSpent: number;
      remaining: number;
      progress: number;
      overspent: Array<{
        categoryId: string;
        categoryName: string;
        categoryIcon: string | null;
        budget: number;
        spent: number;
        over: number;
      }>;
      byCategory: Array<{
        categoryId: string;
        categoryName: string;
        categoryIcon: string | null;
        budget: number;
        spent: number;
      }>;
    }> = [];

    for (let i = safeCount - 1; i >= 0; i--) {
      const ref = this._shiftPeriod(now, period, -i);
      const [pStart, pEnd] = this.computePeriod(period, ref);

      const byCategory: typeof periods[number]['byCategory'] = [];
      let totalSpent = 0;
      let totalBudget = 0;
      for (const b of budgets) {
        if (!b.categoryId) continue;
        const spent = await this._spentOf(
          ledgerId,
          b.categoryId,
          pStart,
          pEnd,
        );
        const budget = Number(b.amount);
        totalSpent += spent;
        totalBudget += budget;
        byCategory.push({
          categoryId: b.categoryId,
          categoryName: b.category?.name ?? '',
          categoryIcon: b.category?.icon ?? null,
          budget,
          spent,
        });
      }

      const overspent = byCategory
        .filter((c) => c.spent > c.budget && c.budget > 0)
        .map((c) => ({ ...c, over: c.spent - c.budget }))
        .sort((a, b) => b.over - a.over);

      const remaining = totalBudget - totalSpent;
      const progress =
        totalBudget > 0 ? Math.min(totalSpent / totalBudget, 999) : 0;

      periods.push({
        periodStart: pStart.toISOString(),
        periodEnd: pEnd.toISOString(),
        label:
          period === 'YEARLY'
            ? `${pStart.getFullYear()}年`
            : `${pStart.getFullYear()}-${String(pStart.getMonth() + 1).padStart(2, '0')}`,
        totalBudget,
        totalSpent,
        remaining,
        progress,
        overspent,
        byCategory,
      });
    }

    return { period, periods };
  }

  private async _spentOf(
    ledgerId: string,
    categoryId: string | null,
    start: Date,
    end: Date,
  ): Promise<number> {
    // 子分类支出会自动聚合到父分类下：如果该预算分类有子分类，把子分类也算上
    const ids: string[] = [];
    if (categoryId) {
      ids.push(categoryId);
      const children = await this.prisma.category.findMany({
        where: { parentId: categoryId },
        select: { id: true },
      });
      ids.push(...children.map((c) => c.id));
    }
    const where: Prisma.BillWhereInput = {
      ledgerId,
      type: 'expense',
      isTransfer: false, // 转账不算预算消耗
      date: { gte: start, lte: end },
    };
    if (ids.length) where.categoryId = { in: ids };
    const agg = await this.prisma.bill.aggregate({
      where,
      _sum: { amount: true },
    });
    return Number(agg._sum.amount || 0);
  }

  /// 把 [from] 沿着 [period] 方向偏移 [n] 个周期（n 负数=往前）
  private _shiftPeriod(
    from: Date,
    period: 'MONTHLY' | 'YEARLY',
    n: number,
  ): Date {
    if (period === 'YEARLY') {
      return new Date(from.getFullYear() + n, from.getMonth(), from.getDate());
    }
    return new Date(from.getFullYear(), from.getMonth() + n, 1);
  }

  /** 计算 MONTHLY / YEARLY 当前周期的起止时间 */
  private computePeriod(
    period: 'MONTHLY' | 'YEARLY',
    now: Date,
  ): [Date, Date] {
    if (period === 'YEARLY') {
      return [
        new Date(now.getFullYear(), 0, 1, 0, 0, 0),
        new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999),
      ];
    }
    return [
      new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0),
      new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999),
    ];
  }

  async create(ledgerId: string, dto: CreateBudgetDto) {
    const budget = await this.prisma.budget.create({
      data: {
        ledgerId,
        categoryId: dto.categoryId ?? null,
        amount: new Prisma.Decimal(dto.amount),
        period: dto.period,
        startDate: new Date(dto.startDate),
      },
      include: { category: true },
    });
    return { message: '创建成功', budget: this.serialize(budget) };
  }

  async update(ledgerId: string, id: string, dto: UpdateBudgetDto) {
    await this.findOneOrFail(ledgerId, id);
    const budget = await this.prisma.budget.update({
      where: { id },
      data: {
        ...(dto.amount !== undefined && { amount: new Prisma.Decimal(dto.amount) }),
        ...(dto.period && { period: dto.period }),
        ...(dto.startDate && { startDate: new Date(dto.startDate) }),
        ...(dto.categoryId !== undefined && { categoryId: dto.categoryId ?? null }),
      },
      include: { category: true },
    });
    return { message: '更新成功', budget: this.serialize(budget) };
  }

  async remove(ledgerId: string, id: string) {
    await this.findOneOrFail(ledgerId, id);
    await this.prisma.budget.delete({ where: { id } });
    return { message: '删除成功' };
  }

  private async findOneOrFail(ledgerId: string, id: string) {
    const budget = await this.prisma.budget.findFirst({ where: { id, ledgerId } });
    if (!budget) throw new NotFoundException('预算不存在');
    return budget;
  }

  private serialize(budget: any) {
    return { ...budget, amount: Number(budget.amount) };
  }
}

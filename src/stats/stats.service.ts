import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class StatsService {
  constructor(private prisma: PrismaService) {}

  async getStats(
    ledgerId: string,
    userId: string,
    startDate?: string,
    endDate?: string,
  ) {
    // ── 日期范围（endDate 取当天 23:59:59 以包含全天）──
    const start = startDate ? new Date(startDate) : null;
    const end = endDate ? new Date(`${endDate}T23:59:59.999`) : null;

    const where: Prisma.BillWhereInput = { ledgerId };
    if (start || end) {
      where.date = {};
      if (start) (where.date as any).gte = start;
      if (end) (where.date as any).lte = end;
    }

    // ── 拼接 raw SQL 的 WHERE 子句（使用 Prisma.join 避免 empty 拼接出错）──
    const conditions: Prisma.Sql[] = [Prisma.sql`b."ledgerId" = ${ledgerId}`];
    if (start) conditions.push(Prisma.sql`b.date >= ${start}`);
    if (end) conditions.push(Prisma.sql`b.date <= ${end}`);
    const whereSql = Prisma.join(conditions, ' AND ');

    const [
      categoryStats,
      monthlyStats,
      incomeAgg,
      expenseAgg,
      accountStats,
      memberStatsRaw,
    ] = await Promise.all([
      // 分类统计
      this.prisma.$queryRaw<any[]>`
          SELECT c.id, c.name, c.icon, c.color, b.type,
                 SUM(b.amount)::float AS total,
                 COUNT(*)::int        AS count
          FROM "Bill" b
          JOIN "Category" c ON b."categoryId" = c.id
          WHERE ${whereSql}
          GROUP BY c.id, c.name, c.icon, c.color, b.type
          ORDER BY total DESC
        `,
      // 月度趋势
      this.prisma.$queryRaw<any[]>`
          SELECT to_char(b.date, 'YYYY-MM') AS month,
                 b.type,
                 SUM(b.amount)::float       AS total,
                 COUNT(*)::int              AS count
          FROM "Bill" b
          WHERE ${whereSql}
          GROUP BY to_char(b.date, 'YYYY-MM'), b.type
          ORDER BY month ASC
        `,
      this.prisma.bill.aggregate({
        where: { ...where, type: 'income' },
        _sum: { amount: true },
      }),
      this.prisma.bill.aggregate({
        where: { ...where, type: 'expense' },
        _sum: { amount: true },
      }),
      // 账户：取账本下**所有**账户（用于全家资产统计）
      // 注意：单账户的余额详情仍有访问控制，但聚合统计需要全家数据
      this.prisma.account.findMany({
        where: { ledgerId },
        select: {
          id: true,
          name: true,
          type: true,
          balance: true,
          ownerId: true,
        },
      }),
      // 按 *记账人* 聚合（仅在共享账本下有意义）
      this.prisma.$queryRaw<any[]>`
          SELECT u.id          AS "userId",
                 u.username    AS username,
                 u.nickname    AS nickname,
                 b.type        AS type,
                 SUM(b.amount)::float AS total,
                 COUNT(*)::int        AS count
          FROM "Bill" b
          JOIN "User" u ON b."userId" = u.id
          WHERE ${whereSql}
          GROUP BY u.id, u.username, u.nickname, b.type
          ORDER BY total DESC
        `,
    ]);

    const totalIncome = Number(incomeAgg._sum.amount || 0);
    const totalExpense = Number(expenseAgg._sum.amount || 0);

    // ─── 资产汇总（家庭口径：全部账户） ──────────────────────
    const mineTotal = accountStats
      .filter((a) => a.ownerId === userId)
      .reduce((s, a) => s + Number(a.balance), 0);
    const sharedTotal = accountStats
      .filter((a) => a.ownerId === null)
      .reduce((s, a) => s + Number(a.balance), 0);
    const othersTotal = accountStats
      .filter((a) => a.ownerId !== null && a.ownerId !== userId)
      .reduce((s, a) => s + Number(a.balance), 0);
    const familyTotal = mineTotal + sharedTotal + othersTotal;
    const assetSummary = {
      total: familyTotal,
      mine: mineTotal,
      shared: sharedTotal,
      others: othersTotal,
    };

    // ─── 资产趋势：按家庭口径（全部账户）倒推 ─────────────────
    const assetTrend = await this.computeAssetTrend(
      ledgerId,
      accountStats.map((a) => a.id),
      familyTotal,
      start,
      end,
    );

    return {
      summary: {
        totalIncome,
        totalExpense,
        balance: totalIncome - totalExpense,
      },
      categoryStats: categoryStats.map((s) => ({
        id: s.id,
        name: s.name,
        icon: s.icon,
        color: s.color,
        type: s.type,
        total: Number(s.total),
        count: Number(s.count),
      })),
      monthlyStats: monthlyStats.map((s) => ({
        month: s.month,
        type: s.type,
        total: Number(s.total),
        count: Number(s.count),
      })),
      // 仅返回当前用户能看到的账户详情（防止泄露他人余额）；
      // 聚合统计用的是全量 accountStats，但单账户列表受访问控制
      accounts: accountStats
        .filter((a) => a.ownerId === null || a.ownerId === userId)
        .map((a) => ({
          id: a.id,
          name: a.name,
          type: a.type,
          balance: Number(a.balance),
          ownerId: a.ownerId,
          isShared: a.ownerId === null,
        })),
      memberStats: _aggregateByMember(memberStatsRaw),
      assetSummary,
      assetTrend,
    };
  }

  /// 计算资产走势：在 [start, end] 范围内每天的"日终总资产"
  /// 返回最多 ~366 个点（一年内）
  private async computeAssetTrend(
    ledgerId: string,
    accessibleAccountIds: string[],
    currentTotal: number,
    start: Date | null,
    end: Date | null,
  ): Promise<Array<{ date: string; balance: number }>> {
    if (!start || accessibleAccountIds.length === 0) return [];

    const today = new Date();
    today.setHours(23, 59, 59, 999);
    const trendEnd = end && end < today ? end : today;
    const trendStart = new Date(start);
    trendStart.setHours(0, 0, 0, 0);

    if (trendStart > trendEnd) return [];

    // 取从 trendStart 到 today 之间所有相关账单（用来 backfill 每天的净变动）
    const bills = await this.prisma.bill.findMany({
      where: {
        ledgerId,
        accountId: { in: accessibleAccountIds },
        date: { gte: trendStart },
      },
      select: { date: true, type: true, amount: true },
    });

    // 按日聚合
    const byDay = new Map<string, number>();
    for (const b of bills) {
      const key = dateKey(b.date);
      const change = (b.type === 'income' ? 1 : -1) * Number(b.amount);
      byDay.set(key, (byDay.get(key) ?? 0) + change);
    }

    // 倒推：cursor 表示"这一天结束时的总资产"
    // 从今天开始：balance[today] = currentTotal
    // 走到昨天：balance[yesterday] = balance[today] - byDay[today]
    let cursor = currentTotal;
    const points: Array<{ date: string; balance: number }> = [];

    const d = new Date(today);
    d.setHours(0, 0, 0, 0);

    while (d >= trendStart) {
      const key = dateKey(d);
      if (d <= trendEnd) {
        points.unshift({
          date: key,
          balance: Number(cursor.toFixed(2)),
        });
      }
      // 减去今天的净变动，得到昨天的日终余额
      cursor -= byDay.get(key) ?? 0;
      d.setDate(d.getDate() - 1);
    }

    return points;
  }
}

function dateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/// 把 [{userId, username, type, total, count}] 按用户聚合成
/// [{userId, username, income, expense, count}]
function _aggregateByMember(rows: any[]) {
  const m = new Map<string, any>();
  for (const r of rows) {
    const id = r.userId;
    if (!m.has(id)) {
      const nick = (r.nickname ?? '').toString().trim();
      m.set(id, {
        userId: id,
        username: r.username,
        nickname: r.nickname ?? null,
        displayName: nick.length > 0 ? nick : r.username,
        income: 0,
        expense: 0,
        count: 0,
      });
    }
    const entry = m.get(id);
    const total = Number(r.total);
    const count = Number(r.count);
    if (r.type === 'income') entry.income += total;
    else entry.expense += total;
    entry.count += count;
  }
  return [...m.values()].sort(
    (a, b) => b.income + b.expense - (a.income + a.expense),
  );
}

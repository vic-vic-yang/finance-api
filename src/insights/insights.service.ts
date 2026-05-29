import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LedgersService } from '../ledgers/ledgers.service';

/**
 * 一条洞察。所有字段服务器都能根据明文（amount/date/categoryId/categoryName）生成，
 * 不依赖任何加密字段。
 *
 * id 用 (type, target) 拼出来，保证幂等：同一情况只对应同一条洞察，
 * 用户对它的"已忽略"才能精确匹配。
 */
export interface Insight {
  id: string;
  type:
    | 'anomaly_bill'
    | 'anomaly_cat_up'
    | 'anomaly_cat_down'
    | 'budget_alert'
    | 'recurring_due';
  severity: 'info' | 'warning' | 'critical';
  target: string;
  title: string;
  body: string;
  data?: any;
  actions?: { label: string; intent: string; params?: any }[];
}

@Injectable()
export class InsightsService {
  constructor(
    private prisma: PrismaService,
    private ledgers: LedgersService,
  ) {}

  // ── 主入口 ──────────────────────────────────────────────────

  async list(userId: string, ledgerId: string): Promise<{ insights: Insight[] }> {
    await this.ledgers.ensureMembership(userId, ledgerId);

    const [anomalies, trends, budgetAlerts, recurringDues, dismissals] =
      await Promise.all([
        this._detectBillAnomalies(ledgerId),
        this._detectCategoryTrends(ledgerId),
        this._detectBudgetAlerts(ledgerId),
        this._detectRecurringDue(ledgerId),
        this.prisma.aiInsightDismissal.findMany({
          where: { userId, ledgerId, expireAt: { gt: new Date() } },
          select: { type: true, target: true },
        }),
      ]);

    const all = [...anomalies, ...trends, ...budgetAlerts, ...recurringDues];

    // 过滤"已忽略"
    const dismissedSet = new Set(
      dismissals.map((d) => `${d.type}|${d.target}`),
    );
    const filtered = all.filter(
      (i) => !dismissedSet.has(`${i.type}|${i.target}`),
    );

    // 优先级排序：critical > warning > info；同档按 type 字典序
    const sevRank = { critical: 0, warning: 1, info: 2 };
    filtered.sort((a, b) => {
      const r = sevRank[a.severity] - sevRank[b.severity];
      if (r !== 0) return r;
      return a.type.localeCompare(b.type);
    });

    return { insights: filtered };
  }

  async dismiss(
    userId: string,
    ledgerId: string,
    type: string,
    target: string,
  ) {
    await this.ledgers.ensureMembership(userId, ledgerId);

    // critical 类（预算 100%、单笔大额）忽略期减半 = 15 天，其他 30 天
    const isCritical = type === 'budget_alert' || type === 'anomaly_bill';
    const days = isCritical ? 15 : 30;
    const expireAt = new Date();
    expireAt.setDate(expireAt.getDate() + days);

    await this.prisma.aiInsightDismissal.upsert({
      where: {
        userId_ledgerId_type_target: { userId, ledgerId, type, target },
      },
      create: { userId, ledgerId, type, target, expireAt },
      update: { dismissedAt: new Date(), expireAt },
    });
    return { message: '已忽略', expireAt };
  }

  // ── 检测器 ──────────────────────────────────────────────────

  /** 单笔大额：> 该分类近 3 月均值 × 3，或 > 1000 */
  private async _detectBillAnomalies(ledgerId: string): Promise<Insight[]> {
    const now = new Date();
    const since = new Date(now);
    since.setDate(since.getDate() - 30); // 看最近 30 天的"异常"

    const recent = await this.prisma.bill.findMany({
      where: {
        ledgerId,
        type: 'expense',
        date: { gte: since },
      },
      include: { category: { select: { name: true, icon: true } } },
    });
    if (recent.length === 0) return [];

    // 近 3 月每个分类的均值
    const threeMonthsAgo = new Date(now);
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
    const histAgg = await this.prisma.bill.groupBy({
      by: ['categoryId'],
      where: {
        ledgerId,
        type: 'expense',
        date: { gte: threeMonthsAgo, lt: since }, // 用更早的当基线
      },
      _avg: { amount: true },
      _count: { _all: true },
    });
    const meanByCat = new Map<string, number>();
    for (const a of histAgg) {
      meanByCat.set(a.categoryId, Number(a._avg.amount || 0));
    }

    const insights: Insight[] = [];
    for (const b of recent) {
      const amt = Number(b.amount);
      const catMean = meanByCat.get(b.categoryId) ?? 0;
      const isHuge = amt > 1000;
      const isOutlier = catMean > 0 && amt > catMean * 3 && amt > 100;
      if (!isHuge && !isOutlier) continue;

      const sev: Insight['severity'] = amt > 5000 ? 'critical' : 'warning';
      const catLabel = b.category?.name ?? '未分类';
      insights.push({
        id: `anomaly_bill|${b.id}`,
        type: 'anomaly_bill',
        severity: sev,
        target: b.id,
        title: `🔴 大额支出 ¥${amt.toFixed(2)}`,
        body: isOutlier
          ? `${catLabel}分类平均 ¥${catMean.toFixed(0)}，这笔是平均的 ${(amt / catMean).toFixed(1)} 倍`
          : `分类：${catLabel}`,
        data: { billId: b.id, amount: amt, categoryId: b.categoryId, date: b.date },
      });
    }
    // 只保留 top 5（避免一次性轰炸）
    return insights.slice(0, 5);
  }

  /** 分类同比涨跌：本月 vs 上月，>30% 涨 / <-20% 跌 */
  private async _detectCategoryTrends(ledgerId: string): Promise<Insight[]> {
    const now = new Date();
    const thisStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);

    const [thisMonth, lastMonth] = await Promise.all([
      this.prisma.bill.groupBy({
        by: ['categoryId'],
        where: {
          ledgerId,
          type: 'expense',
          date: { gte: thisStart },
        },
        _sum: { amount: true },
      }),
      this.prisma.bill.groupBy({
        by: ['categoryId'],
        where: {
          ledgerId,
          type: 'expense',
          date: { gte: lastStart, lte: lastEnd },
        },
        _sum: { amount: true },
      }),
    ]);

    const lastMap = new Map(
      lastMonth.map((r) => [r.categoryId, Number(r._sum.amount || 0)]),
    );
    const catIds = thisMonth.map((r) => r.categoryId);
    const cats = await this.prisma.category.findMany({
      where: { id: { in: catIds } },
      select: { id: true, name: true, icon: true },
    });
    const catMap = new Map(cats.map((c) => [c.id, c]));

    const insights: Insight[] = [];
    for (const r of thisMonth) {
      const cur = Number(r._sum.amount || 0);
      const prev = lastMap.get(r.categoryId) ?? 0;
      if (cur < 100 && prev < 100) continue; // 太小没意义
      const cat = catMap.get(r.categoryId);
      const label = cat?.name ?? '未分类';

      if (prev > 0 && cur / prev > 1.3) {
        const pct = Math.round(((cur - prev) / prev) * 100);
        insights.push({
          id: `anomaly_cat_up|${r.categoryId}`,
          type: 'anomaly_cat_up',
          severity: 'warning',
          target: r.categoryId,
          title: `🟡 ${label}本月 ↑${pct}%`,
          body: `已花 ¥${cur.toFixed(0)}，比上月同期多 ¥${(cur - prev).toFixed(0)}`,
          data: { categoryId: r.categoryId, current: cur, previous: prev },
        });
      } else if (prev > 100 && cur / prev < 0.8) {
        const pct = Math.round(((prev - cur) / prev) * 100);
        insights.push({
          id: `anomaly_cat_down|${r.categoryId}`,
          type: 'anomaly_cat_down',
          severity: 'info',
          target: r.categoryId,
          title: `🟢 ${label}本月 ↓${pct}%`,
          body: `比上月少花 ¥${(prev - cur).toFixed(0)}，继续保持 👍`,
          data: { categoryId: r.categoryId, current: cur, previous: prev },
        });
      }
    }
    return insights;
  }

  /** 预算预警：使用率 70/90/100% 三档 */
  private async _detectBudgetAlerts(ledgerId: string): Promise<Insight[]> {
    const budgets = await this.prisma.budget.findMany({
      where: { ledgerId, categoryId: { not: null } },
      include: { category: { select: { name: true, icon: true } } },
    });
    if (budgets.length === 0) return [];

    const now = new Date();
    const insights: Insight[] = [];

    for (const b of budgets) {
      const [start, end] = this._budgetPeriod(b.period, now);
      const ids = await this._categoryWithChildren(b.categoryId!);
      const agg = await this.prisma.bill.aggregate({
        where: {
          ledgerId,
          type: 'expense',
          categoryId: { in: ids },
          date: { gte: start, lte: end },
        },
        _sum: { amount: true },
      });
      const spent = Number(agg._sum.amount || 0);
      const limit = Number(b.amount);
      if (limit <= 0) continue;
      const rate = spent / limit;

      let severity: Insight['severity'] = 'info';
      let bucket = '';
      if (rate >= 1) {
        severity = 'critical';
        bucket = '100';
      } else if (rate >= 0.9) {
        severity = 'warning';
        bucket = '90';
      } else if (rate >= 0.7) {
        severity = 'info';
        bucket = '70';
      } else {
        continue;
      }

      const label = b.category?.name ?? '总预算';
      const periodLabel = b.period === 'YEARLY' ? '本年' : '本月';
      const overText =
        rate >= 1
          ? `已超 ¥${(spent - limit).toFixed(0)}`
          : `剩 ¥${(limit - spent).toFixed(0)}`;
      insights.push({
        id: `budget_alert|${b.id}_${bucket}`,
        type: 'budget_alert',
        severity,
        target: `${b.id}_${bucket}`,
        title: `${rate >= 1 ? '🔴' : rate >= 0.9 ? '🟠' : '💡'} ${label}${periodLabel}预算已用 ${Math.round(rate * 100)}%`,
        body: `预算 ¥${limit.toFixed(0)} · 已花 ¥${spent.toFixed(0)} · ${overText}`,
        data: { budgetId: b.id, categoryId: b.categoryId, spent, limit, rate },
      });
    }
    return insights;
  }

  /** 周期账单即将到期：距 nextDate ≤ 3 天 */
  private async _detectRecurringDue(ledgerId: string): Promise<Insight[]> {
    const now = new Date();
    const in3Days = new Date(now);
    in3Days.setDate(in3Days.getDate() + 3);

    const dueList = await this.prisma.recurringBill.findMany({
      where: {
        ledgerId,
        isActive: true,
        nextDate: { gte: now, lte: in3Days },
      },
      include: { category: { select: { name: true, icon: true } } },
    });

    return dueList.map<Insight>((r) => {
      const days = Math.ceil(
        (r.nextDate.getTime() - now.getTime()) / 86_400_000,
      );
      const when =
        days <= 0 ? '今天' : days === 1 ? '明天' : days === 2 ? '后天' : `${days}天后`;
      const label = r.category?.name ?? '账单';
      return {
        id: `recurring_due|${r.id}`,
        type: 'recurring_due',
        severity: 'info',
        target: r.id,
        title: `📅 ${label} ${when}到期`,
        body: `金额 ¥${Number(r.amount).toFixed(2)}`,
        data: { recurringId: r.id, nextDate: r.nextDate, amount: Number(r.amount) },
        actions: [
          { label: '提前记一笔', intent: 'createBillFromRecurring', params: { recurringId: r.id } },
        ],
      };
    });
  }

  // ── 工具 ────────────────────────────────────────────────────

  private _budgetPeriod(period: string, now: Date): [Date, Date] {
    if (period === 'YEARLY') {
      return [
        new Date(now.getFullYear(), 0, 1),
        new Date(now.getFullYear(), 11, 31, 23, 59, 59),
      ];
    }
    return [
      new Date(now.getFullYear(), now.getMonth(), 1),
      new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59),
    ];
  }

  /** 一个分类 + 它的所有子分类 id（用于预算聚合，和 budgets.service 行为一致） */
  private async _categoryWithChildren(categoryId: string): Promise<string[]> {
    const children = await this.prisma.category.findMany({
      where: { parentId: categoryId },
      select: { id: true },
    });
    return [categoryId, ...children.map((c) => c.id)];
  }
}

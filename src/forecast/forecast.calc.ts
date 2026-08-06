import { Prisma } from '@prisma/client';

/**
 * 现金流预测 · 纯函数核心
 *
 * 所有金额一律 Prisma.Decimal，禁止 JS 浮点算术。
 * 收支统计口径由调用方保证：isTransfer = false 且 source != 'stock'
 * （转账与股票纸面盈亏都不是现金流）。
 */

// ── 月末净资产预测 ─────────────────────────────────────────────

export interface MonthEndNetWorthInput {
  /** 当前账户合计（可见账户余额之和） */
  currentNetWorth: Prisma.Decimal;
  /** 近 30 日日均净流入（收入 − 支出，可为负） */
  avgDailyNetInflow: Prisma.Decimal;
  /** 本月剩余天数（不含今天） */
  remainingDays: number;
  /** 本月剩余周期账单净额（收入加 / 支出减） */
  remainingRecurringNet: Prisma.Decimal;
}

/**
 * 月末净资产 = 当前合计 + 剩余天数 × 日均净流入 + 本月剩余周期账单净额
 *
 * 注意：日均法对「月发性大额收入（工资）」严重失真，仅作为
 * 无完整月历史时的兜底；优先用 monthlyPatternForecast。
 */
export function monthEndNetWorth(
  i: MonthEndNetWorthInput,
): Prisma.Decimal {
  return i.currentNetWorth
    .plus(i.avgDailyNetInflow.mul(i.remainingDays))
    .plus(i.remainingRecurringNet);
}

// ── 固定收入识别 ───────────────────────────────────────────────

export interface IncomeBillLike {
  amount: Prisma.Decimal;
  /** 当月的第几天（1-31） */
  dayOfMonth: number;
  categoryId: string;
}

export interface RecurringIncomePattern {
  categoryId: string;
  /** 历史出现金额的均值（预期到账额） */
  expectedAmount: Prisma.Decimal;
  /** 在几个完整月里出现过 */
  monthCount: number;
  /** 本月是否已到账 */
  fulfilled: boolean;
}

export interface RecurringIncomeResult {
  /** 本月尚未到账的固定收入合计 */
  expectedRemaining: Prisma.Decimal;
  patterns: RecurringIncomePattern[];
}

/**
 * 固定收入检测：把近 N 个完整月的每笔收入按「同分类 + 金额相近」聚类，
 * 至少在 2 个月出现的簇视为固定收入项（工资/房租等月发事件）；
 * 对照本月已收：已到账 → 不再预期，未到账 → 按历史均值预期。
 * 一次性收入（只出现 1 个月）不参与预测——保守，不虚增。
 */
export function detectRecurringIncome(
  prevMonths: IncomeBillLike[][],
  thisMonth: IncomeBillLike[],
  tolerancePct = 0.05,
): RecurringIncomeResult {
  interface Cluster {
    categoryId: string;
    amounts: Prisma.Decimal[];
    months: Set<number>;
  }
  const clusters: Cluster[] = [];
  const within = (a: Prisma.Decimal, b: Prisma.Decimal) => {
    const tol = Prisma.Decimal.max(b.abs().mul(tolerancePct), 1);
    return a.minus(b).abs().lte(tol);
  };
  prevMonths.forEach((bills, monthIdx) => {
    for (const bill of bills) {
      // 簇代表值用均值，找同分类且金额相近的簇
      const hit = clusters.find((c) => {
        if (c.categoryId !== bill.categoryId) return false;
        const mean = c.amounts
          .reduce((s, x) => s.plus(x), new Prisma.Decimal(0))
          .div(c.amounts.length);
        return within(bill.amount, mean);
      });
      if (hit) {
        hit.amounts.push(bill.amount);
        hit.months.add(monthIdx);
      } else {
        clusters.push({
          categoryId: bill.categoryId,
          amounts: [bill.amount],
          months: new Set([monthIdx]),
        });
      }
    }
  });

  const patterns: RecurringIncomePattern[] = [];
  let expectedRemaining = new Prisma.Decimal(0);
  for (const c of clusters) {
    if (c.months.size < 2) continue; // 一次性收入不预期
    const expectedAmount = c.amounts
      .reduce((s, x) => s.plus(x), new Prisma.Decimal(0))
      .div(c.amounts.length);
    const fulfilled = thisMonth.some(
      (b) => b.categoryId === c.categoryId && within(b.amount, expectedAmount),
    );
    patterns.push({
      categoryId: c.categoryId,
      expectedAmount,
      monthCount: c.months.size,
      fulfilled,
    });
    if (!fulfilled) expectedRemaining = expectedRemaining.plus(expectedAmount);
  }
  return { expectedRemaining, patterns };
}

// ── 月度模式预测（主算法） ─────────────────────────────────────

export interface MonthlyPatternInput {
  /** 当前账户合计（可见账户余额之和） */
  currentNetWorth: Prisma.Decimal;
  /** 本月至今收入 / 支出（真收支口径） */
  mtdIncome: Prisma.Decimal;
  mtdExpense: Prisma.Decimal;
  /** 近 N 个完整自然月的月均收入 / 支出 */
  avgMonthlyIncome: Prisma.Decimal;
  avgMonthlyExpense: Prisma.Decimal;
  /** 本月已过天数（含今天；传 0 按 1 天兜底） */
  daysElapsed: number;
  /** 本月剩余天数（不含今天） */
  remainingDays: number;
  /** 固定收入检测结果（detectRecurringIncome）；传入后替代「月均 − 已收」 */
  expectedRemainingIncome?: Prisma.Decimal;
}

export interface MonthlyPatternResult {
  projected: Prisma.Decimal;
  /** 预计剩余收入 = max(0, 月均收入 − 本月已收) */
  remainingIncome: Prisma.Decimal;
  /** 预计剩余支出 = max(本月日均×剩余天数, 月均支出 − 本月已花) */
  remainingExpense: Prisma.Decimal;
}

/**
 * 按「月度收支模式」预测月末净资产：
 *  - 收入是月发事件（工资）：剩余收入 = max(0, 月均 − 已收)，
 *    没发预期会来、已发过不再虚增；
 *  - 支出相对平滑：剩余支出取「当前节奏外推」与「回归历史月均」的较大者，
 *    花得快按节奏、花得慢不低估；
 *  - 周期扣款已含在历史月均中，不再重复加计。
 */
export function monthlyPatternForecast(
  i: MonthlyPatternInput,
): MonthlyPatternResult {
  const zero = new Prisma.Decimal(0);
  const remainingIncome =
    i.expectedRemainingIncome ??
    Prisma.Decimal.max(zero, i.avgMonthlyIncome.minus(i.mtdIncome));
  const elapsed = Math.max(1, i.daysElapsed);
  const paceRemaining = i.mtdExpense.div(elapsed).mul(i.remainingDays);
  const revertRemaining = Prisma.Decimal.max(
    zero,
    i.avgMonthlyExpense.minus(i.mtdExpense),
  );
  const remainingExpense = Prisma.Decimal.max(paceRemaining, revertRemaining);
  const projected = i.currentNetWorth
    .plus(remainingIncome)
    .minus(remainingExpense);
  return { projected, remainingIncome, remainingExpense };
}

// ── 周期账单净额 ───────────────────────────────────────────────

/** 周期账单参与计算的最小字段集 */
export interface RecurringLike {
  /** 'income' | 'expense' */
  type: string;
  amount: Prisma.Decimal;
  nextDate: Date;
}

/**
 * 窗口 [from, to]（含两端）内周期账单的净额：income 加 / expense 减。
 * 窗口外的一律不计。
 */
export function recurringNetBetween(
  items: RecurringLike[],
  from: Date,
  to: Date,
): Prisma.Decimal {
  const lo = from.getTime();
  const hi = to.getTime();
  let net = new Prisma.Decimal(0);
  for (const r of items) {
    const t = r.nextDate.getTime();
    if (t < lo || t > hi) continue;
    net = r.type === 'income' ? net.plus(r.amount) : net.minus(r.amount);
  }
  return net;
}

// ── 支出速率 ───────────────────────────────────────────────────

export interface ExpensePaceInput {
  /** 本月至今支出 */
  monthToDateExpense: Prisma.Decimal;
  /** 本月已过天数（含今天；传 0 按 1 天兜底，不除零） */
  daysElapsed: number;
  /** 当月总天数 */
  daysInMonth: number;
  /** 当月总预算（无预算传 null） */
  monthlyBudget: Prisma.Decimal | null;
}

export interface ExpensePaceResult {
  /** 按当前速率外推的当月总支出 = 至今支出 / 已过天数 × 当月天数 */
  projectedMonthExpense: Prisma.Decimal;
  /** 有预算（>0）且外推支出 > 预算 */
  overspendRisk: boolean;
}

export function expensePace(i: ExpensePaceInput): ExpensePaceResult {
  const elapsed = Math.max(1, i.daysElapsed);
  const projectedMonthExpense = i.monthToDateExpense
    .div(elapsed)
    .mul(i.daysInMonth);
  const overspendRisk =
    i.monthlyBudget !== null &&
    i.monthlyBudget.gt(0) &&
    projectedMonthExpense.gt(i.monthlyBudget);
  return { projectedMonthExpense, overspendRisk };
}

// ── 目标达成预测 ───────────────────────────────────────────────

export interface GoalEtaInput {
  /** 还需存入（targetAmount − currentSaved；≤0 表示已达成） */
  remaining: Prisma.Decimal;
  /** 近 90 天月均净存入（(收入 − 支出) / 3；≤0 表示存不下钱） */
  monthlyRate: Prisma.Decimal;
  now: Date;
}

/** 平均月长（天）：365.25 / 12 */
const AVG_MONTH_DAYS = 30.44;

/**
 * 预计达成日期：
 *  - 已达成（remaining ≤ 0）→ now
 *  - 月均净存入 ≤ 0 → null（无法估算）
 *  - 否则 now + ceil(remaining / monthlyRate × 30.44) 天
 */
export function goalEtaDate(i: GoalEtaInput): Date | null {
  if (i.remaining.lte(0)) return new Date(i.now);
  if (i.monthlyRate.lte(0)) return null;
  const months = i.remaining.div(i.monthlyRate);
  const days = Math.ceil(months.mul(AVG_MONTH_DAYS).toNumber());
  const eta = new Date(i.now);
  eta.setDate(eta.getDate() + days);
  return eta;
}

import { Prisma } from '@prisma/client';

type Decimal = Prisma.Decimal;

/**
 * 财务健康评分 · 纯函数打分层
 *
 * 设计约束（与 CFO 检测器同一条隐私不变式）：
 *  - 只消费明文字段聚合结果（amount / date / type / balance / budget / loan），
 *    绝不接触 noteCipher / nameCipher 密文。
 *  - 权重、分档阈值全部写死在本文件，scorer.spec.ts 直接单测。
 */

export type DimensionKey =
  | 'savingRate'
  | 'budgetDiscipline'
  | 'emergencyFund'
  | 'recordStreak'
  | 'debtPressure';

/** 当月某项预算的执行情况（MONTHLY 预算） */
export interface BudgetUsage {
  /** 预算上限 */
  amount: Decimal;
  /** 当月已用（含子分类，过滤转账与 stock） */
  used: Decimal;
}

/** 打分输入：全部由 service 用纯 SQL 聚合好，本层不再碰数据库 */
export interface HealthInput {
  /** 近 3 个完整月收入合计（isTransfer=false 且 source != 'stock'） */
  last3Income: Decimal;
  /** 近 3 个完整月支出合计（同口径） */
  last3Expense: Decimal;
  /** 当月 MONTHLY 预算执行情况；空数组 = 未设预算 */
  budgets: BudgetUsage[];
  /** 可见账户余额合计（CREDIT / DEBT 等负债账户的负余额按 0 计） */
  assetBalance: Decimal;
  /** 近 30 天内有账单的天数（0-30，任意类型账单都算「记了账」） */
  recordDays: number;
  /** loans 表 borrow 方向未还本金合计（amount − repaidAmount，未结清） */
  outstandingBorrow: Decimal;
}

export interface DimensionScore {
  key: DimensionKey;
  label: string;
  /** 0-100 */
  score: number;
  weight: number;
  /** 一句话现状 */
  headline: string;
  /** 一句话建议 */
  advice: string;
}

export interface HealthScore {
  /** 0-100 加权总分 */
  score: number;
  /** S / A / B / C / D */
  grade: string;
  dimensions: DimensionScore[];
}

// ── 常量（阈值全部写死在这里，方便单测） ─────────────────────

/** 数据不足时的中性分 */
export const NEUTRAL_SCORE = 60;

/** 各维度权重（合计 100） */
export const WEIGHTS: Record<DimensionKey, number> = {
  savingRate: 25,
  budgetDiscipline: 20,
  emergencyFund: 25,
  recordStreak: 15,
  debtPressure: 15,
};

/** 等级分档：score >= min 即落入该档（自上而下取第一个） */
export const GRADE_BANDS: ReadonlyArray<{ grade: string; min: number }> = [
  { grade: 'S', min: 90 },
  { grade: 'A', min: 80 },
  { grade: 'B', min: 70 },
  { grade: 'C', min: 60 },
  { grade: 'D', min: 0 },
];

/** 储蓄率映射：rate = 0 → 50 分，rate ≥ +30% → 100 分，rate ≤ −30% → 0 分（线性） */
export const SAVING_RATE_FULL = 0.3;
/** 应急金满分对应的可撑月数 */
export const EMERGENCY_FULL_MONTHS = 6;
/** 记账坚持度统计窗口（天） */
export const STREAK_WINDOW_DAYS = 30;
/** 负债压力：未还借款 / 资产 ≥ 该比例 → 0 分（0 → 100 分，线性） */
export const DEBT_RATIO_ZERO = 0.5;

const clampScore = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

export function gradeOf(score: number): string {
  for (const band of GRADE_BANDS) {
    if (score >= band.min) return band.grade;
  }
  return 'D';
}

// ── 各维度打分 ───────────────────────────────────────────────

function dim(
  key: DimensionKey,
  label: string,
  score: number,
  headline: string,
  advice: string,
): DimensionScore {
  return { key, label, score: clampScore(score), weight: WEIGHTS[key], headline, advice };
}

/** 1. 储蓄率：近 3 个完整月 (收入−支出)/收入 */
export function savingRateDim(income: Decimal, expense: Decimal): DimensionScore {
  const label = '储蓄率';
  if (income.lte(0)) {
    return dim('savingRate', label, NEUTRAL_SCORE, '近 3 个月暂无收入记录', '数据不足，先记几笔收入再来看看');
  }
  const rate = income.minus(expense).div(income).toNumber();
  const score = clampScore(50 + (rate * 50) / SAVING_RATE_FULL);
  const pct = Math.abs(rate * 100).toFixed(0);
  const headline =
    rate >= 0 ? `近 3 月储蓄率 ${pct}%` : `近 3 月入不敷出 ${pct}%`;
  const advice =
    score >= 80
      ? '储蓄节奏很好，可考虑把结余转入储蓄目标'
      : score >= 60
        ? '储蓄率还有提升空间，试试给大额分类设预算'
        : '支出逼近甚至超过收入，建议先压缩非必要开销';
  return dim('savingRate', label, score, headline, advice);
}

/** 2. 预算纪律：当月 MONTHLY 预算中未超支的占比 */
export function budgetDisciplineDim(budgets: BudgetUsage[]): DimensionScore {
  const label = '预算纪律';
  if (budgets.length === 0) {
    return dim('budgetDiscipline', label, NEUTRAL_SCORE, '尚未设置预算', '先建预算，给每月花销定个标尺');
  }
  const ok = budgets.filter((b) => b.used.lte(b.amount)).length;
  const score = clampScore((ok / budgets.length) * 100);
  const headline = `${ok}/${budgets.length} 项预算未超支`;
  const advice =
    ok === budgets.length
      ? '本月预算全部守住，继续保持'
      : '有预算已超支，点开「预算」看看哪类花超了';
  return dim('budgetDiscipline', label, score, headline, advice);
}

/** 3. 应急金：资产合计 ÷ 近 3 月月均支出 = 可撑月数，≥ 6 个月满分 */
export function emergencyFundDim(assetBalance: Decimal, last3Expense: Decimal): DimensionScore {
  const label = '应急金';
  const avgExpense = last3Expense.div(3);
  if (avgExpense.lte(0)) {
    return dim('emergencyFund', label, NEUTRAL_SCORE, '近 3 个月支出数据不足', '数据不足，多记几笔账，才能估出应急金可撑月数');
  }
  const months = Math.max(0, assetBalance.div(avgExpense).toNumber());
  const score = clampScore((months / EMERGENCY_FULL_MONTHS) * 100);
  const headline = `应急金约可撑 ${months.toFixed(1)} 个月`;
  const advice =
    months >= EMERGENCY_FULL_MONTHS
      ? '应急储备充足，很稳'
      : months >= 3
        ? '建议逐步把应急金攒到 6 个月支出'
        : '应急金偏薄，优先补到 3 个月支出';
  return dim('emergencyFund', label, score, headline, advice);
}

/** 4. 记账坚持度：近 30 天有账单的天数占比 */
export function recordStreakDim(recordDays: number): DimensionScore {
  const label = '记账坚持度';
  const days = Math.max(0, Math.min(STREAK_WINDOW_DAYS, Math.round(recordDays)));
  const score = clampScore((days / STREAK_WINDOW_DAYS) * 100);
  const headline = `近 ${STREAK_WINDOW_DAYS} 天记账 ${days} 天`;
  const advice =
    days >= 25
      ? '记账习惯很棒，继续保持'
      : days >= 15
        ? '继续保持，争取每天都记一笔'
        : '记账越勤，洞察越准，试试每天睡前记一笔';
  return dim('recordStreak', label, score, headline, advice);
}

/** 5. 负债压力：borrow 未还本金 ÷ 资产合计，越低越好；无借贷满分 */
export function debtPressureDim(outstanding: Decimal, assetBalance: Decimal): DimensionScore {
  const label = '负债压力';
  if (outstanding.lte(0)) {
    return dim('debtPressure', label, 100, '无未还借款', '没有借贷压力，很好');
  }
  if (assetBalance.lte(0)) {
    return dim(
      'debtPressure', label, 0,
      `未还借款 ¥${outstanding.toFixed(0)}，已超过可见资产`,
      '优先偿还高息借款，避免利滚利',
    );
  }
  const ratio = outstanding.div(assetBalance).toNumber();
  const score = clampScore(((DEBT_RATIO_ZERO - ratio) / DEBT_RATIO_ZERO) * 100);
  const headline = `未还借款 ¥${outstanding.toFixed(0)}，约占资产 ${(ratio * 100).toFixed(0)}%`;
  const advice =
    score >= 70 ? '负债水平可控，按计划还款即可' : '负债占比偏高，建议制定还款计划';
  return dim('debtPressure', label, score, headline, advice);
}

// ── 总入口 ───────────────────────────────────────────────────

export function scoreHealth(input: HealthInput): HealthScore {
  const dimensions: DimensionScore[] = [
    savingRateDim(input.last3Income, input.last3Expense),
    budgetDisciplineDim(input.budgets),
    emergencyFundDim(input.assetBalance, input.last3Expense),
    recordStreakDim(input.recordDays),
    debtPressureDim(input.outstandingBorrow, input.assetBalance),
  ];
  const totalWeight = dimensions.reduce((s, d) => s + d.weight, 0);
  const score =
    totalWeight > 0
      ? clampScore(dimensions.reduce((s, d) => s + d.score * d.weight, 0) / totalWeight)
      : 0;
  return { score, grade: gradeOf(score), dimensions };
}

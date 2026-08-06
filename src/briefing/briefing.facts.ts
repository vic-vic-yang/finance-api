import { Prisma } from '@prisma/client';

type Decimal = Prisma.Decimal;

/**
 * 每周管家简报 · 事实聚合层（纯函数，可单测）
 *
 * 隐私不变式（与 CFO 检测器 / 健康分 scorer 同一条）：
 *  - 只消费明文字段（amount / date / type / categoryId / balance / budget），
 *    绝不接触 noteCipher / nameCipher 密文，facts 里也没有备注 / 名称原文。
 *  - 收支聚合一律过滤 isTransfer=false 且 source != 'stock'
 *    （前者排除转账双腿，后者排除股票纸面盈亏）。
 *  - 金额一律 Prisma.Decimal 运算，仅序列化时转 number。
 *
 * 数据由 BriefingService 用 SQL 聚合好后传入，本层不碰数据库。
 */

// ── 输入 ─────────────────────────────────────────────────────

export interface BriefingBillInput {
  id: string;
  type: string; // income / expense
  amount: Decimal;
  categoryId: string;
  isTransfer: boolean;
  source: string; // stock 的纸面盈亏要排除
  date: Date;
}

export interface BriefingBudgetInput {
  /** null = 总预算 */
  categoryId: string | null;
  amount: Decimal;
}

export interface BriefingCategoryInput {
  id: string;
  name: string;
  parentId: string | null;
}

export interface BriefingRecurringInput {
  id: string;
  categoryId: string;
  amount: Decimal;
  type: string; // expense / income
  nextDate: Date;
}

export interface BriefingFactsInput {
  /** 上周一 00:00（本地时区） */
  weekStart: Date;
  /** 两周窗口 [上上周一, 上周日] 内的全部账单（本层自行过滤） */
  bills: BriefingBillInput[];
  /** MONTHLY 预算 */
  budgets: BriefingBudgetInput[];
  /** 本月至今按分类聚合的支出（已过滤转账 / stock；子分类未归并，本层处理） */
  monthSpentByCategory: Record<string, Decimal>;
  /** 账本可见分类（含系统分类），用于取名与父子归并 */
  categories: BriefingCategoryInput[];
  /** 本周（生成周，周一~周日）到期的启用中周期扣款 */
  recurringDue: BriefingRecurringInput[];
  /** 健康分（0-100）；不可用时 null */
  healthScore: number | null;
}

// ── 输出 ─────────────────────────────────────────────────────

export interface BriefingCategoryAmount {
  categoryId: string;
  name: string;
  amount: number;
}

export interface BriefingLargeExpense {
  categoryId: string;
  categoryName: string;
  amount: number;
  /** YYYY-MM-DD */
  date: string;
}

export interface BriefingBudgetOverspend {
  categoryId: string | null;
  name: string;
  budget: number;
  spent: number;
  over: number;
}

export interface BriefingUpcomingRecurring {
  categoryId: string;
  categoryName: string;
  amount: number;
  type: string;
  /** YYYY-MM-DD */
  nextDate: string;
}

export interface BriefingFacts {
  /** YYYY-MM-DD，上周一 / 上周日 / 上上周一 / 上上周日 */
  weekStart: string;
  weekEnd: string;
  prevWeekStart: string;
  prevWeekEnd: string;
  /** 上周记账笔数（含转账等全部账单） */
  billCount: number;
  expense: number;
  income: number;
  prevExpense: number;
  prevIncome: number;
  /** 环比 %（一位小数）；上上周为 0 时 null（无可比基期） */
  expenseChangePct: number | null;
  incomeChangePct: number | null;
  /** 上周支出 Top 3 分类 */
  topExpenseCategories: BriefingCategoryAmount[];
  /** 大额支出（≤3 笔，金额降序） */
  largeExpenses: BriefingLargeExpense[];
  /** 本月已超支的预算（超出额降序） */
  budgetOverspend: BriefingBudgetOverspend[];
  /** 本周将到期的周期扣款 */
  upcomingRecurring: BriefingUpcomingRecurring[];
  healthScore: number | null;
  /** 确定性建议（模板正文与前端「管家建议」卡共用同一结论） */
  advice: string;
}

// ── 常量（阈值写死，方便单测） ────────────────────────────────

/** 大额支出绝对阈值（与 cfo large-expense 检测器一致） */
export const LARGE_EXPENSE_ABS = 1000;
/** 大额支出相对口径：超过当周总支出该比例且超过 LARGE_EXPENSE_RATIO_MIN */
export const LARGE_EXPENSE_WEEK_RATIO = 0.2;
export const LARGE_EXPENSE_RATIO_MIN = 100;
/** 大额支出最多列几笔 */
export const LARGE_EXPENSE_MAX = 3;
/** Top 支出分类条数 */
export const TOP_CATEGORY_MAX = 3;
/** 环比涨幅超过该值（%）时建议关注 */
export const ADVICE_RISE_PCT = 30;

// ── 工具 ─────────────────────────────────────────────────────

export function dateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 上周一 00:00（本地时区） */
export function lastWeekMonday(now: Date): Date {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dow = (d.getDay() + 6) % 7; // 周一=0 … 周日=6
  d.setDate(d.getDate() - dow - 7);
  return d;
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function endOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
}

const zero = () => new Prisma.Decimal(0);

/** 收支统计口径：排除转账双腿与股票纸面盈亏 */
function countable(b: BriefingBillInput): boolean {
  return !b.isTransfer && b.source !== 'stock';
}

/** 环比 %（一位小数，四舍五入）；基期 ≤ 0 时 null */
export function changePct(cur: Decimal, prev: Decimal): number | null {
  if (prev.lte(0)) return null;
  const pct = cur.minus(prev).div(prev).mul(100).toNumber();
  return Math.round(pct * 10) / 10;
}

// ── 主入口 ───────────────────────────────────────────────────

/**
 * 聚合上周（周一~周日）vs 上上周的简报事实。
 * 上周 0 笔账单（任意类型都算「记了账」）→ 返回 null（空周不生成简报）。
 */
export function assembleBriefingFacts(
  input: BriefingFactsInput,
): BriefingFacts | null {
  const weekStart = new Date(
    input.weekStart.getFullYear(),
    input.weekStart.getMonth(),
    input.weekStart.getDate(),
  );
  const weekEnd = endOfDay(addDays(weekStart, 6));
  const prevStart = addDays(weekStart, -7);
  const prevEnd = new Date(weekStart.getTime() - 1);

  const inRange = (d: Date, s: Date, e: Date) => d >= s && d <= e;
  const weekBills = input.bills.filter((b) => inRange(b.date, weekStart, weekEnd));
  if (weekBills.length === 0) return null; // 空数据周：不生成

  const prevBills = input.bills.filter((b) => inRange(b.date, prevStart, prevEnd));

  const sum = (bills: BriefingBillInput[], type: string) =>
    bills
      .filter((b) => b.type === type && countable(b))
      .reduce((s, b) => s.add(b.amount), zero());

  const expense = sum(weekBills, 'expense');
  const income = sum(weekBills, 'income');
  const prevExpense = sum(prevBills, 'expense');
  const prevIncome = sum(prevBills, 'income');

  const catName = new Map(input.categories.map((c) => [c.id, c.name]));

  // ── Top 3 支出分类（按账单原始分类聚合，不归并父类——周报要具体）──
  const byCat = new Map<string, Decimal>();
  for (const b of weekBills) {
    if (b.type !== 'expense' || !countable(b)) continue;
    byCat.set(b.categoryId, (byCat.get(b.categoryId) ?? zero()).add(b.amount));
  }
  const topExpenseCategories: BriefingCategoryAmount[] = [...byCat.entries()]
    .sort((a, b) => b[1].cmp(a[1]))
    .slice(0, TOP_CATEGORY_MAX)
    .map(([categoryId, amt]) => ({
      categoryId,
      name: catName.get(categoryId) ?? '未分类',
      amount: amt.toNumber(),
    }));

  // ── 大额支出：绝对阈值，或 > 周支出 20% 且超过下限 ──
  const largeExpenses: BriefingLargeExpense[] = weekBills
    .filter((b) => {
      if (b.type !== 'expense' || !countable(b)) return false;
      if (b.amount.gte(LARGE_EXPENSE_ABS)) return true;
      return (
        expense.gt(0) &&
        b.amount.gt(expense.mul(LARGE_EXPENSE_WEEK_RATIO)) &&
        b.amount.gte(LARGE_EXPENSE_RATIO_MIN)
      );
    })
    .sort((a, b) => b.amount.cmp(a.amount))
    .slice(0, LARGE_EXPENSE_MAX)
    .map((b) => ({
      categoryId: b.categoryId,
      categoryName: catName.get(b.categoryId) ?? '未分类',
      amount: b.amount.toNumber(),
      date: dateKey(b.date),
    }));

  // ── 预算执行：本月至今（生成时点）已超支的 MONTHLY 预算（含子分类归并）──
  const childrenOf = new Map<string, string[]>();
  for (const c of input.categories) {
    if (!c.parentId) continue;
    const arr = childrenOf.get(c.parentId) ?? [];
    arr.push(c.id);
    childrenOf.set(c.parentId, arr);
  }
  const monthTotal = Object.values(input.monthSpentByCategory).reduce(
    (s, a) => s.add(a),
    zero(),
  );
  const spentFor = (categoryId: string | null): Decimal => {
    if (!categoryId) return monthTotal;
    const ids = new Set([categoryId, ...(childrenOf.get(categoryId) ?? [])]);
    let s = zero();
    for (const [cid, amt] of Object.entries(input.monthSpentByCategory)) {
      if (ids.has(cid)) s = s.add(amt);
    }
    return s;
  };
  const budgetOverspend: BriefingBudgetOverspend[] = input.budgets
    .map((b) => {
      const spent = spentFor(b.categoryId);
      const over = spent.minus(b.amount);
      return { b, spent, over };
    })
    .filter((x) => x.b.amount.gt(0) && x.over.gt(0))
    .sort((a, b2) => b2.over.cmp(a.over))
    .map(({ b, spent, over }) => ({
      categoryId: b.categoryId,
      name: b.categoryId ? (catName.get(b.categoryId) ?? '未分类') : '总预算',
      budget: b.amount.toNumber(),
      spent: spent.toNumber(),
      over: over.toNumber(),
    }));

  // ── 本周到期的周期扣款（名称是密文送不了，只给分类 / 金额 / 日期）──
  const upcomingRecurring: BriefingUpcomingRecurring[] = input.recurringDue
    .map((r) => ({
      categoryId: r.categoryId,
      categoryName: catName.get(r.categoryId) ?? '未分类',
      amount: r.amount.toNumber(),
      type: r.type,
      nextDate: dateKey(r.nextDate),
    }))
    .sort((a, b) => a.nextDate.localeCompare(b.nextDate));

  const facts: Omit<BriefingFacts, 'advice'> = {
    weekStart: dateKey(weekStart),
    weekEnd: dateKey(weekEnd),
    prevWeekStart: dateKey(prevStart),
    prevWeekEnd: dateKey(prevEnd),
    billCount: weekBills.length,
    expense: expense.toNumber(),
    income: income.toNumber(),
    prevExpense: prevExpense.toNumber(),
    prevIncome: prevIncome.toNumber(),
    expenseChangePct: changePct(expense, prevExpense),
    incomeChangePct: changePct(income, prevIncome),
    topExpenseCategories,
    largeExpenses,
    budgetOverspend,
    upcomingRecurring,
    healthScore: input.healthScore,
  };

  return { ...facts, advice: pickAdvice(facts) };
}

// ── 确定性建议（模板正文与前端建议卡共用） ─────────────────────

export function fmtMoney(n: number): string {
  return `¥${n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function pickAdvice(f: Omit<BriefingFacts, 'advice'>): string {
  if (f.budgetOverspend.length > 0) {
    const top = f.budgetOverspend[0];
    return `「${top.name}」预算已超支 ${fmtMoney(top.over)}，本周这类开销先缓一缓；如果是常态，就把预算调到更贴合实际的数字。`;
  }
  if (f.expenseChangePct != null && f.expenseChangePct >= ADVICE_RISE_PCT) {
    return `支出环比上涨 ${f.expenseChangePct}%，建议翻翻上周账单，看看是哪几笔带起来的。`;
  }
  if (f.upcomingRecurring.length > 0) {
    const total = f.upcomingRecurring.reduce((s, r) => s + r.amount, 0);
    return `本周有 ${f.upcomingRecurring.length} 笔周期扣款（约 ${fmtMoney(total)}），记得在对应账户留好余额。`;
  }
  if (f.income > f.expense) {
    return `上周结余 ${fmtMoney(f.income - f.expense)}，可以考虑转入储蓄目标，让结余开始为你工作。`;
  }
  return '继续保持记账节奏，数据越完整，我给的判断越准。';
}

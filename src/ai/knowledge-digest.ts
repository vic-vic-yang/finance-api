import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * 财务知识库摘要（Knowledge Digest）
 * ─────────────────────────────────────────────────────────────
 * 对话问答时，把「当前账本的真实数据摘要」按关键词路由选出相关切片，
 * 文本化后注入 LLM 上下文，让司库助手直接基于真实数据回答
 * （「上个月哪类花最多」「预算还剩多少」「我欠别人多少钱」…）。
 *
 * 隐私红线：本文件只聚合明文字段（amount / date / type / categoryId /
 * balance / 预算 / 目标金额 / 借贷本金），绝不读取 noteCipher / nameCipher。
 * 收支口径与统计/预算一致：isTransfer = false 且 source != 'stock'。
 *
 * 纯函数（路由 / 文本化 / 截断）与 SQL 构建分离，纯函数有 Jest 单测。
 */

// ── 结构化切片类型 ────────────────────────────────────────────

export interface CategoryBucket {
  name: string;
  amount: number;
  count: number;
}

export interface MonthSlice {
  income: number;
  expense: number;
  count: number;
  /** 支出 TOP 分类（金额降序） */
  topExpense: CategoryBucket[];
  /** 上一个自然月的支出 / 收入（用于环比），无数据为 null */
  prevExpense: number | null;
  prevIncome: number | null;
}

export interface BudgetSliceItem {
  categoryName: string;
  period: 'MONTHLY' | 'YEARLY';
  spent: number;
  limit: number;
}

export interface GoalSliceItem {
  /** 目标名是密文 → 用序号代替（目标 1 / 目标 2…） */
  label: string;
  saved: number;
  target: number;
  /** 0~1+，可能超过 1（超额完成） */
  progress: number;
  isCompleted: boolean;
}

export interface LoanSlice {
  /** 借入未还（我欠别人） */
  borrowOutstanding: number;
  borrowCount: number;
  /** 借出未收（别人欠我） */
  lendOutstanding: number;
  lendCount: number;
}

export interface AccountSlice {
  count: number;
  totalBalance: number;
  /** 信用卡账户余额合计（通常为负=待还） */
  creditBalance: number;
  /** 负债账户余额合计 */
  debtBalance: number;
}

export interface DigestSlices {
  thisMonth: MonthSlice;
  lastMonth: MonthSlice;
  budgets: BudgetSliceItem[];
  goals: GoalSliceItem[];
  loans: LoanSlice;
  accounts: AccountSlice;
}

export type SliceKey =
  | 'thisMonth'
  | 'lastMonth'
  | 'budgets'
  | 'goals'
  | 'loans'
  | 'accounts';

/** 注入文本总长的硬上限（约 800 字） */
export const DIGEST_MAX_CHARS = 800;

// ── 关键词路由（纯函数） ──────────────────────────────────────

/**
 * 路由规则：按声明顺序匹配，命中即并入（同一切片去重）。
 * 任何规则都没命中 → 兜底返回全量切片（紧凑模式）。
 */
export const ROUTE_RULES: { keywords: string[]; slices: SliceKey[] }[] = [
  { keywords: ['预算'], slices: ['budgets'] },
  { keywords: ['目标', '储蓄', '存钱', '攒钱'], slices: ['goals'] },
  // 注意：不用裸「还」字（会误中「预算还剩多少」），用还款/还钱/还债
  { keywords: ['欠', '借', '还款', '还钱', '还债', '负债', '贷款'], slices: ['loans'] },
  {
    keywords: ['上月', '上个月', '环比', '同比'],
    slices: ['lastMonth', 'thisMonth'],
  },
  {
    keywords: ['分类', '哪类', '花得最多', '花最多', '最多'],
    slices: ['thisMonth', 'lastMonth'],
  },
  { keywords: ['本月', '这个月', '这月'], slices: ['thisMonth'] },
  {
    keywords: ['余额', '账户', '资产', '多少钱', '净资产'],
    slices: ['accounts'],
  },
];

/** 全量兜底时的切片顺序（紧凑模式同样按此序拼接） */
const ALL_SLICES: SliceKey[] = [
  'thisMonth',
  'lastMonth',
  'budgets',
  'goals',
  'loans',
  'accounts',
];

/**
 * 按用户消息选出相关切片。
 * 命中规则按固定顺序（ALL_SLICES）返回去重后的切片；
 * 无匹配 → 返回全量（兜底摘要）。
 */
export function routeSlices(message: string): SliceKey[] {
  const hit = new Set<SliceKey>();
  for (const rule of ROUTE_RULES) {
    if (rule.keywords.some((k) => message.includes(k))) {
      for (const s of rule.slices) hit.add(s);
    }
  }
  if (hit.size === 0) return [...ALL_SLICES];
  return ALL_SLICES.filter((s) => hit.has(s));
}

// ── 文本化（纯函数） ──────────────────────────────────────────

const fmt = (n: number): string => `¥${n.toFixed(2)}`;

function fmtPct(ratio: number): string {
  const sign = ratio > 0 ? '+' : '';
  return `${sign}${(ratio * 100).toFixed(1)}%`;
}

function monthSliceText(label: string, s: MonthSlice, topN: number): string {
  const parts: string[] = [
    `收入 ${fmt(s.income)}`,
    `支出 ${fmt(s.expense)}（${s.count} 笔）`,
  ];
  if (s.prevExpense != null && s.prevExpense > 0) {
    parts.push(`支出环比 ${fmtPct(s.expense / s.prevExpense - 1)}`);
  }
  if (s.topExpense.length > 0) {
    const tops = s.topExpense
      .slice(0, topN)
      .map((t) => `${t.name} ${fmt(t.amount)}`)
      .join('、');
    parts.push(`支出 TOP${Math.min(topN, s.topExpense.length)}：${tops}`);
  } else {
    parts.push('暂无支出分类数据');
  }
  return `【${label}】${parts.join('，')}。`;
}

function budgetsText(items: BudgetSliceItem[]): string {
  if (items.length === 0) return '【预算执行】当前账本未设任何预算。';
  const rows = items.map((b) => {
    const remaining = b.limit - b.spent;
    const rate = b.limit > 0 ? Math.round((b.spent / b.limit) * 100) : 0;
    const tag = b.period === 'YEARLY' ? '年' : '月';
    return `${b.categoryName}（${tag}）：已用 ${fmt(b.spent)} / ${fmt(b.limit)}（${rate}%），剩 ${fmt(remaining)}`;
  });
  return `【预算执行】${rows.join('；')}。`;
}

function goalsText(items: GoalSliceItem[]): string {
  if (items.length === 0) return '【储蓄目标】还没有创建储蓄目标。';
  const rows = items.map((g) => {
    const pct = Math.round(g.progress * 100);
    const state = g.isCompleted ? '已完成' : `${pct}%`;
    return `${g.label}：已存 ${fmt(g.saved)} / ${fmt(g.target)}（${state}）`;
  });
  return `【储蓄目标】${rows.join('；')}。`;
}

function loansText(s: LoanSlice): string {
  if (s.borrowCount === 0 && s.lendCount === 0) {
    return '【借贷往来】当前没有未结清的借贷。';
  }
  const parts: string[] = [];
  if (s.borrowCount > 0) {
    parts.push(`我欠别人（借入）未还 ${fmt(s.borrowOutstanding)}（${s.borrowCount} 笔）`);
  }
  if (s.lendCount > 0) {
    parts.push(`别人欠我（借出）未收 ${fmt(s.lendOutstanding)}（${s.lendCount} 笔）`);
  }
  return `【借贷往来】${parts.join('；')}。`;
}

function accountsText(s: AccountSlice): string {
  if (s.count === 0) return '【账户总览】还没有账户。';
  const parts = [`共 ${s.count} 个账户`, `合计余额 ${fmt(s.totalBalance)}`];
  if (s.creditBalance !== 0) parts.push(`信用卡账户合计 ${fmt(s.creditBalance)}`);
  if (s.debtBalance !== 0) parts.push(`负债账户合计 ${fmt(s.debtBalance)}`);
  return `【账户总览】${parts.join('，')}。`;
}

/** 单个切片 → 文本段落 */
export function sliceToText(
  key: SliceKey,
  slices: DigestSlices,
  topN: number,
): string {
  switch (key) {
    case 'thisMonth':
      return monthSliceText('本月收支', slices.thisMonth, topN);
    case 'lastMonth':
      return monthSliceText('上月收支', slices.lastMonth, topN);
    case 'budgets':
      return budgetsText(slices.budgets);
    case 'goals':
      return goalsText(slices.goals);
    case 'loans':
      return loansText(slices.loans);
    case 'accounts':
      return accountsText(slices.accounts);
  }
}

const HEADER =
  '以下是用户账本的真实数据摘要，请基于它回答（摘要没覆盖的再调工具查询）：';

/**
 * 组装注入文本：按路由选切片 → 文本化 → 控制在 DIGEST_MAX_CHARS 以内。
 * 截断策略：先用 TOP5 拼全量；超限则降到 TOP3 重拼；仍超限硬截断。
 */
export function buildKnowledgeText(
  message: string,
  slices: DigestSlices,
  maxChars: number = DIGEST_MAX_CHARS,
): string {
  const keys = routeSlices(message);
  const build = (topN: number) =>
    [HEADER, ...keys.map((k) => sliceToText(k, slices, topN))].join('\n');

  let text = build(5);
  if (text.length <= maxChars) return text;
  text = build(3);
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars - 1) + '…';
}

// ── SQL 摘要构建（仅明文字段聚合） ────────────────────────────

const startOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1);
const endOfMonth = (d: Date) =>
  new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);

/** 收支公共 where：转账腿与股票纸面盈亏都不算收支 */
const flowWhere = (ledgerId: string, start: Date, end: Date) => ({
  ledgerId,
  isTransfer: false,
  source: { not: 'stock' },
  date: { gte: start, lte: end },
});

async function monthSlice(
  prisma: PrismaService,
  ledgerId: string,
  start: Date,
  end: Date,
  prevExpense: number | null,
  prevIncome: number | null,
): Promise<MonthSlice> {
  const base = flowWhere(ledgerId, start, end);
  const [incAgg, expAgg, grouped] = await Promise.all([
    prisma.bill.aggregate({
      where: { ...base, type: 'income' },
      _sum: { amount: true },
      _count: { _all: true },
    }),
    prisma.bill.aggregate({
      where: { ...base, type: 'expense' },
      _sum: { amount: true },
      _count: { _all: true },
    }),
    prisma.bill.groupBy({
      by: ['categoryId'],
      where: { ...base, type: 'expense' },
      _sum: { amount: true },
      _count: { _all: true },
    }),
  ]);
  const catIds = grouped.map((g) => g.categoryId);
  const cats = catIds.length
    ? await prisma.category.findMany({
        where: { id: { in: catIds } },
        select: { id: true, name: true, parentId: true },
      })
    : [];
  const parentIds = cats.map((c) => c.parentId).filter(Boolean) as string[];
  const parents = parentIds.length
    ? await prisma.category.findMany({
        where: { id: { in: parentIds } },
        select: { id: true, name: true },
      })
    : [];
  const parentMap = new Map(parents.map((p) => [p.id, p.name]));
  const catMap = new Map(
    cats.map((c) => [
      c.id,
      c.parentId ? `${parentMap.get(c.parentId) ?? ''}›${c.name}` : c.name,
    ]),
  );
  const topExpense = grouped
    .map((g) => ({
      name: catMap.get(g.categoryId) ?? '未分类',
      amount: Number(g._sum.amount ?? 0),
      count: g._count._all,
    }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 5);

  return {
    income: Number(incAgg._sum.amount ?? 0),
    expense: Number(expAgg._sum.amount ?? 0),
    count: incAgg._count._all + expAgg._count._all,
    topExpense,
    prevExpense,
    prevIncome,
  };
}

async function totalsFor(
  prisma: PrismaService,
  ledgerId: string,
  start: Date,
  end: Date,
): Promise<{ income: number; expense: number }> {
  const base = flowWhere(ledgerId, start, end);
  const [incAgg, expAgg] = await Promise.all([
    prisma.bill.aggregate({
      where: { ...base, type: 'income' },
      _sum: { amount: true },
    }),
    prisma.bill.aggregate({
      where: { ...base, type: 'expense' },
      _sum: { amount: true },
    }),
  ]);
  return {
    income: Number(incAgg._sum.amount ?? 0),
    expense: Number(expAgg._sum.amount ?? 0),
  };
}

function budgetPeriod(p: string, now: Date): [Date, Date] {
  if (p === 'YEARLY') {
    return [
      new Date(now.getFullYear(), 0, 1),
      new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999),
    ];
  }
  return [startOfMonth(now), endOfMonth(now)];
}

/**
 * 从 SQL 聚合出全部结构化切片。只读明文字段；
 * 账户/目标/借贷的名字密文一律不读，目标用序号代替。
 */
export async function buildDigestSlices(
  prisma: PrismaService,
  ledgerId: string,
  userId: string,
  now: Date = new Date(),
): Promise<DigestSlices> {
  const thisStart = startOfMonth(now);
  const thisEnd = endOfMonth(now);
  const lastStart = startOfMonth(new Date(now.getFullYear(), now.getMonth() - 1, 1));
  const lastEnd = endOfMonth(lastStart);
  const prevStart = startOfMonth(
    new Date(now.getFullYear(), now.getMonth() - 2, 1),
  );
  const prevEnd = endOfMonth(prevStart);

  // 上上月合计（供上月环比）
  const prevTotals = await totalsFor(prisma, ledgerId, prevStart, prevEnd);
  const lastTotals = await totalsFor(prisma, ledgerId, lastStart, lastEnd);

  const [lastMonth, thisMonth] = await Promise.all([
    monthSlice(
      prisma,
      ledgerId,
      lastStart,
      lastEnd,
      prevTotals.expense > 0 ? prevTotals.expense : null,
      prevTotals.income > 0 ? prevTotals.income : null,
    ),
    monthSlice(
      prisma,
      ledgerId,
      thisStart,
      thisEnd,
      lastTotals.expense > 0 ? lastTotals.expense : null,
      lastTotals.income > 0 ? lastTotals.income : null,
    ),
  ]);

  // ── 预算执行 ──
  const budgetRows = await prisma.budget.findMany({
    where: { ledgerId, categoryId: { not: null } },
    include: { category: { select: { name: true } } },
  });
  const budgets: BudgetSliceItem[] = [];
  for (const b of budgetRows) {
    const [start, end] = budgetPeriod(b.period, now);
    // 子分类支出聚合到父分类下（与 manageBudget 工具一致）
    const children = await prisma.category.findMany({
      where: { parentId: b.categoryId! },
      select: { id: true },
    });
    const ids = [b.categoryId!, ...children.map((c) => c.id)];
    const agg = await prisma.bill.aggregate({
      where: {
        ...flowWhere(ledgerId, start, end),
        type: 'expense',
        categoryId: { in: ids },
      },
      _sum: { amount: true },
    });
    budgets.push({
      categoryName: b.category?.name ?? '未分类',
      period: b.period === 'YEARLY' ? 'YEARLY' : 'MONTHLY',
      spent: Number(agg._sum.amount ?? 0),
      limit: Number(b.amount),
    });
  }

  // ── 储蓄目标（名字是密文 → 目标 1/2/3…）──
  const goalRows = await prisma.savingsGoal.findMany({
    where: { userId, ledgerId },
    orderBy: { createdAt: 'asc' },
  });
  const goals: GoalSliceItem[] = [];
  for (let i = 0; i < goalRows.length; i++) {
    const g = goalRows[i];
    const target = Number(g.targetAmount);
    let saved: number;
    if (g.accountId) {
      // 绑定账户：进度 = 余额 − 初始快照（与 goals.service 一致）
      const acc = await prisma.account.findUnique({
        where: { id: g.accountId },
        select: { balance: true },
      });
      const initial = g.initialBalance != null ? Number(g.initialBalance) : 0;
      saved = Number(acc?.balance ?? 0) - initial;
    } else {
      // 未绑定账户：起算日以来的收支净额
      const t = await totalsFor(prisma, ledgerId, g.startDate, now);
      saved = t.income - t.expense;
    }
    goals.push({
      label: `目标 ${i + 1}`,
      saved,
      target,
      progress: target > 0 ? Math.max(0, Math.min(saved / target, 999)) : 0,
      isCompleted: g.isCompleted,
    });
  }

  // ── 借贷概况（未结清：settledAt = null）──
  const loanRows = await prisma.loan.findMany({
    where: { ledgerId, settledAt: null },
    select: { direction: true, amount: true, repaidAmount: true },
  });
  let borrowOutstanding = 0;
  let borrowCount = 0;
  let lendOutstanding = 0;
  let lendCount = 0;
  for (const l of loanRows) {
    const outstanding = Number(l.amount) - Number(l.repaidAmount);
    if (outstanding <= 0) continue;
    if (l.direction === 'borrow') {
      borrowOutstanding += outstanding;
      borrowCount++;
    } else {
      lendOutstanding += outstanding;
      lendCount++;
    }
  }

  // ── 账户余额总览（共享账户 + 本人私人账户）──
  const accountRows = await prisma.account.findMany({
    where: { ledgerId, OR: [{ ownerId: null }, { ownerId: userId }] },
    select: { type: true, balance: true },
  });
  let totalBalance = new Prisma.Decimal(0);
  let creditBalance = new Prisma.Decimal(0);
  let debtBalance = new Prisma.Decimal(0);
  for (const a of accountRows) {
    totalBalance = totalBalance.plus(a.balance);
    if (a.type === 'CREDIT') creditBalance = creditBalance.plus(a.balance);
    if (a.type === 'DEBT') debtBalance = debtBalance.plus(a.balance);
  }

  return {
    thisMonth,
    lastMonth,
    budgets,
    goals,
    loans: { borrowOutstanding, borrowCount, lendOutstanding, lendCount },
    accounts: {
      count: accountRows.length,
      totalBalance: Number(totalBalance),
      creditBalance: Number(creditBalance),
      debtBalance: Number(debtBalance),
    },
  };
}

import { Prisma } from '@prisma/client';

type Decimal = Prisma.Decimal;

/**
 * 月度家庭复盘 · 事实聚合层（纯函数，可单测）
 *
 * 隐私不变式（与 briefing / health 同一条）：
 *  - 只消费明文字段（amount / date / type / categoryId / userId / balance / budget），
 *    绝不接触 noteCipher / nameCipher；facts 里没有备注 / 名称原文（目标名由前端解密）。
 *  - 收支聚合一律过滤 isTransfer=false 且 source != 'stock'。
 *  - 金额一律 Prisma.Decimal 运算，仅序列化时转 number。
 */

export interface FamilyReviewBillInput {
  id: string;
  userId: string;
  type: string;
  amount: Decimal;
  categoryId: string;
  isTransfer: boolean;
  source: string;
  date: Date;
}

export interface FamilyReviewBudgetInput {
  categoryId: string | null;
  amount: Decimal;
}

export interface FamilyReviewCategoryInput {
  id: string;
  name: string;
  parentId: string | null;
}

export interface FamilyReviewGoalInput {
  id: string;
  targetAmount: number;
  currentSaved: number;
  progress: number;
  isCompleted: boolean;
}

export interface FamilyReviewMemberInput {
  id: string;
  name: string;
}

export interface FamilyReviewInput {
  monthStart: Date;
  monthEnd: Date;
  bills: FamilyReviewBillInput[];
  budgets: FamilyReviewBudgetInput[];
  categories: FamilyReviewCategoryInput[];
  goals: FamilyReviewGoalInput[];
  members: FamilyReviewMemberInput[];
}

export interface MemberContribution {
  userId: string;
  name: string;
  income: number;
  expense: number;
  net: number;
}

export interface FamilyReviewFacts {
  month: string;
  billCount: number;
  income: number;
  expense: number;
  net: number;
  memberContributions: MemberContribution[];
  topExpenseCategories: { categoryId: string; name: string; amount: number }[];
  budgetOverspend: { categoryId: string | null; name: string; budget: number; spent: number; over: number }[];
  goals: FamilyReviewGoalInput[];
  advice: string;
}

const TOP_CATEGORY_MAX = 5;
const zero = () => new Prisma.Decimal(0);

function countable(b: FamilyReviewBillInput): boolean {
  return !b.isTransfer && b.source !== 'stock';
}

export function familyMonthKey(d: Date): string {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

export function assembleFamilyReview(input: FamilyReviewInput): FamilyReviewFacts {
  const month = familyMonthKey(input.monthStart);
  const bills = input.bills.filter(countable);

  const sum = (type: string) =>
    bills.filter((b) => b.type === type).reduce((s, b) => s.add(b.amount), zero());
  const income = sum('income');
  const expense = sum('expense');
  const net = income.sub(expense);

  // 成员贡献（谁记了多少收入 / 支出）
  const nameById = new Map(input.members.map((m) => [m.id, m.name]));
  const byMember = new Map<string, { income: Decimal; expense: Decimal }>();
  for (const b of bills) {
    const e = byMember.get(b.userId) ?? { income: zero(), expense: zero() };
    if (b.type === 'income') e.income = e.income.add(b.amount);
    else e.expense = e.expense.add(b.amount);
    byMember.set(b.userId, e);
  }
  const memberContributions: MemberContribution[] = [...byMember.entries()]
    .map(([userId, e]) => ({
      userId,
      name: nameById.get(userId) ?? '成员',
      income: e.income.toNumber(),
      expense: e.expense.toNumber(),
      net: e.income.sub(e.expense).toNumber(),
    }))
    .sort((a, b) => b.expense - a.expense);

  // Top 支出分类（按原始分类，不归并父类）
  const catName = new Map(input.categories.map((c) => [c.id, c.name]));
  const byCat = new Map<string, Decimal>();
  for (const b of bills) {
    if (b.type !== 'expense') continue;
    byCat.set(b.categoryId, (byCat.get(b.categoryId) ?? zero()).add(b.amount));
  }
  const topExpenseCategories = [...byCat.entries()]
    .sort((a, b) => b[1].cmp(a[1]))
    .slice(0, TOP_CATEGORY_MAX)
    .map(([categoryId, amount]) => ({
      categoryId,
      name: catName.get(categoryId) ?? '未分类',
      amount: amount.toNumber(),
    }));

  // 预算超支（含子分类归并）
  const childrenOf = new Map<string, string[]>();
  for (const c of input.categories) {
    if (!c.parentId) continue;
    const arr = childrenOf.get(c.parentId) ?? [];
    arr.push(c.id);
    childrenOf.set(c.parentId, arr);
  }
  const spentFor = (categoryId: string | null): Decimal => {
    if (!categoryId) return expense;
    const ids = new Set([categoryId, ...(childrenOf.get(categoryId) ?? [])]);
    let s = zero();
    for (const [cid, amt] of byCat) {
      if (ids.has(cid)) s = s.add(amt);
    }
    return s;
  };
  const budgetOverspend = input.budgets
    .map((b) => ({ b, spent: spentFor(b.categoryId), over: spentFor(b.categoryId).sub(b.amount) }))
    .filter((x) => x.b.amount.gt(0) && x.over.gt(0))
    .sort((a, b2) => b2.over.cmp(a.over))
    .map(({ b, spent, over }) => ({
      categoryId: b.categoryId,
      name: b.categoryId ? (catName.get(b.categoryId) ?? '未分类') : '总预算',
      budget: b.amount.toNumber(),
      spent: spent.toNumber(),
      over: over.toNumber(),
    }));

  const facts: Omit<FamilyReviewFacts, 'advice'> = {
    month,
    billCount: bills.length,
    income: income.toNumber(),
    expense: expense.toNumber(),
    net: net.toNumber(),
    memberContributions,
    topExpenseCategories,
    budgetOverspend,
    goals: input.goals.map((g) => ({ ...g })),
  };

  return { ...facts, advice: pickFamilyAdvice(facts) };
}

function pickFamilyAdvice(f: Omit<FamilyReviewFacts, 'advice'>): string {
  if (f.budgetOverspend.length > 0) {
    return '「' + f.budgetOverspend[0].name + '」预算超支，全家先看看这块开销。';
  }
  if (f.expense > f.income) {
    return '本月家庭入不敷出，建议全家一起看看大额支出。';
  }
  return '本月家庭结余为正，可以考虑把结余转入共同储蓄目标。';
}

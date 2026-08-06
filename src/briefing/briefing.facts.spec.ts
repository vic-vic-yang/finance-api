import { Prisma } from '@prisma/client';
import {
  assembleBriefingFacts,
  changePct,
  lastWeekMonday,
  BriefingFactsInput,
  BriefingBillInput,
} from './briefing.facts';

const D = (n: number) => new Prisma.Decimal(n);

// 2026-07-20 是周一；简报周 = 7/20(一) ~ 7/26(日)，上上周 = 7/13 ~ 7/19
const WEEK_START = new Date(2026, 6, 20);
const day = (d: number, hour = 12) => new Date(2026, 6, d, hour);

let seq = 0;
function bill(over: Partial<BriefingBillInput> & { date: Date }): BriefingBillInput {
  return {
    id: `b${++seq}`,
    type: 'expense',
    amount: D(100),
    categoryId: 'cat-food',
    isTransfer: false,
    source: 'manual',
    ...over,
  };
}

function baseInput(over: Partial<BriefingFactsInput> = {}): BriefingFactsInput {
  return {
    weekStart: WEEK_START,
    bills: [],
    budgets: [],
    monthSpentByCategory: {},
    categories: [
      { id: 'cat-food', name: '餐饮', parentId: null },
      { id: 'cat-food-milk', name: '奶茶', parentId: 'cat-food' },
      { id: 'cat-shop', name: '购物', parentId: null },
      { id: 'cat-salary', name: '工资', parentId: null },
    ],
    recurringDue: [],
    healthScore: 78,
    ...over,
  };
}

describe('lastWeekMonday', () => {
  it('周一当天 → 取上一周周一', () => {
    const m = lastWeekMonday(new Date(2026, 6, 27, 8, 37)); // 2026-07-27 周一
    expect(m.getFullYear()).toBe(2026);
    expect(m.getMonth()).toBe(6);
    expect(m.getDate()).toBe(20);
    expect(m.getHours()).toBe(0);
  });

  it('周日 → 仍取上一周周一（不是当天所在周）', () => {
    const m = lastWeekMonday(new Date(2026, 6, 26, 23, 0)); // 周日
    expect(m.getDate()).toBe(13);
  });

  it('跨月：8 月 1 日 → 上周一为 7 月 20 日', () => {
    const m = lastWeekMonday(new Date(2026, 7, 1, 9, 0)); // 周六
    expect(m.getMonth()).toBe(6);
    expect(m.getDate()).toBe(20);
  });
});

describe('changePct', () => {
  it('正常环比', () => {
    expect(changePct(D(300), D(100))).toBe(200);
    expect(changePct(D(90), D(100))).toBe(-10);
  });

  it('基期为 0 → null（无可比基期）', () => {
    expect(changePct(D(100), D(0))).toBeNull();
  });
});

describe('assembleBriefingFacts', () => {
  it('空数据周（上周 0 笔）→ 返回 null', () => {
    const facts = assembleBriefingFacts(
      baseInput({ bills: [bill({ date: day(15) })] }), // 只有上上周有账
    );
    expect(facts).toBeNull();
  });

  it('收支总额与环比：上周 vs 上上周', () => {
    const facts = assembleBriefingFacts(
      baseInput({
        bills: [
          bill({ date: day(21), amount: D(100) }),
          bill({ date: day(22), amount: D(200), categoryId: 'cat-shop' }),
          bill({ date: day(23), type: 'income', amount: D(500), categoryId: 'cat-salary' }),
          bill({ date: day(14), amount: D(100) }), // 上上周
        ],
      }),
    )!;
    expect(facts).not.toBeNull();
    expect(facts.weekStart).toBe('2026-07-20');
    expect(facts.weekEnd).toBe('2026-07-26');
    expect(facts.prevWeekStart).toBe('2026-07-13');
    expect(facts.expense).toBe(300);
    expect(facts.income).toBe(500);
    expect(facts.prevExpense).toBe(100);
    expect(facts.prevIncome).toBe(0);
    expect(facts.expenseChangePct).toBe(200);
    expect(facts.incomeChangePct).toBeNull(); // 上上周无收入
    expect(facts.billCount).toBe(3);
  });

  it('转账与 stock 纸面盈亏不计入收支统计', () => {
    const facts = assembleBriefingFacts(
      baseInput({
        bills: [
          bill({ date: day(21), amount: D(100) }),
          bill({ date: day(21), amount: D(5000), isTransfer: true }), // 转账双腿
          bill({ date: day(22), amount: D(800), source: 'stock' }), // 股票纸面盈亏
        ],
      }),
    )!;
    expect(facts.expense).toBe(100);
    // 转账 / stock 不计入，但仍是「记了账」（billCount 含全部账单）
    expect(facts.billCount).toBe(3);
  });

  it('Top 3 支出分类按金额降序', () => {
    const facts = assembleBriefingFacts(
      baseInput({
        bills: [
          bill({ date: day(21), amount: D(50) }),
          bill({ date: day(21), amount: D(150) }),
          bill({ date: day(22), amount: D(300), categoryId: 'cat-shop' }),
        ],
      }),
    )!;
    expect(facts.topExpenseCategories.map((c) => c.name)).toEqual(['购物', '餐饮']);
    expect(facts.topExpenseCategories[0].amount).toBe(300);
  });

  it('大额识别：绝对阈值 1000', () => {
    const facts = assembleBriefingFacts(
      baseInput({
        bills: [
          bill({ date: day(21), amount: D(20) }),
          bill({ date: day(22), amount: D(1200), categoryId: 'cat-shop' }),
        ],
      }),
    )!;
    expect(facts.largeExpenses).toHaveLength(1);
    expect(facts.largeExpenses[0].amount).toBe(1200);
    expect(facts.largeExpenses[0].categoryName).toBe('购物');
  });

  it('大额识别：超过周支出 20% 且 ≥100 也算（相对口径）', () => {
    const facts = assembleBriefingFacts(
      baseInput({
        bills: [
          bill({ date: day(21), amount: D(300) }),
          bill({ date: day(22), amount: D(100), categoryId: 'cat-shop' }), // 100/400 = 25%
        ],
      }),
    )!;
    // 两笔都满足「> 周支出 20% 且 ≥100」，按金额降序
    expect(facts.largeExpenses.map((l) => l.amount)).toEqual([300, 100]);
  });

  it('相对口径下限：不足 100 的小额不算大额', () => {
    const facts = assembleBriefingFacts(
      baseInput({
        bills: [
          bill({ date: day(21), amount: D(300) }),
          bill({ date: day(22), amount: D(99), categoryId: 'cat-shop' }), // 99/399≈25% 但 <100
        ],
      }),
    )!;
    expect(facts.largeExpenses.map((l) => l.amount)).toEqual([300]);
  });

  it('预算执行：含子分类归并，超支按超出额降序', () => {
    const facts = assembleBriefingFacts(
      baseInput({
        bills: [bill({ date: day(21), amount: D(10) })],
        budgets: [
          { categoryId: 'cat-food', amount: D(500) },
          { categoryId: 'cat-shop', amount: D(200) },
        ],
        monthSpentByCategory: {
          'cat-food': D(480),
          'cat-food-milk': D(120), // 子分类归并到餐饮 → 600 > 500
          'cat-shop': D(150), // 未超
        },
      }),
    )!;
    expect(facts.budgetOverspend).toHaveLength(1);
    expect(facts.budgetOverspend[0].name).toBe('餐饮');
    expect(facts.budgetOverspend[0].spent).toBe(600);
    expect(facts.budgetOverspend[0].over).toBe(100);
  });

  it('周期扣款：只给分类名 / 金额 / 日期（无名称原文）', () => {
    const facts = assembleBriefingFacts(
      baseInput({
        bills: [bill({ date: day(21), amount: D(10) })],
        recurringDue: [
          {
            id: 'r1',
            categoryId: 'cat-food',
            amount: D(25),
            type: 'expense',
            nextDate: new Date(2026, 6, 28), // 本周二
          },
        ],
      }),
    )!;
    expect(facts.upcomingRecurring).toHaveLength(1);
    expect(facts.upcomingRecurring[0]).toEqual({
      categoryId: 'cat-food',
      categoryName: '餐饮',
      amount: 25,
      type: 'expense',
      nextDate: '2026-07-28',
    });
    // 隐私断言：facts 里没有任何名称 / 备注字段
    expect(JSON.stringify(facts)).not.toContain('r1');
    expect(JSON.stringify(facts)).not.toMatch(/note|merchant/i);
  });

  it('建议优先级：预算超支 > 环比大涨 > 周期扣款 > 结余 > 默认', () => {
    // 预算超支优先
    const f1 = assembleBriefingFacts(
      baseInput({
        bills: [bill({ date: day(21), amount: D(600) }), bill({ date: day(14), amount: D(100) })],
        budgets: [{ categoryId: 'cat-food', amount: D(100) }],
        monthSpentByCategory: { 'cat-food': D(600) },
      }),
    )!;
    expect(f1.advice).toContain('预算已超支');

    // 环比大涨
    const f2 = assembleBriefingFacts(
      baseInput({
        bills: [bill({ date: day(21), amount: D(400) }), bill({ date: day(14), amount: D(100) })],
      }),
    )!;
    expect(f2.advice).toContain('环比上涨');

    // 结余
    const f3 = assembleBriefingFacts(
      baseInput({
        bills: [
          bill({ date: day(21), amount: D(100) }),
          bill({ date: day(21), type: 'income', amount: D(500), categoryId: 'cat-salary' }),
        ],
      }),
    )!;
    expect(f3.advice).toContain('结余');

    // 默认
    const f4 = assembleBriefingFacts(
      baseInput({ bills: [bill({ date: day(21), amount: D(100) })] }),
    )!;
    expect(f4.advice).toContain('记账');
  });
});

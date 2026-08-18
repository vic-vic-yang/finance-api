import { Prisma } from '@prisma/client';
import { assembleFamilyReview, familyMonthKey } from './family-review.facts';

const D = (n: number | string) => new Prisma.Decimal(n);

describe('assembleFamilyReview', () => {
  const base = {
    monthStart: new Date(2025, 5, 1),
    monthEnd: new Date(2025, 5, 30),
    budgets: [] as any[],
    categories: [{ id: 'c1', name: '餐饮', parentId: null }, { id: 'c2', name: '外卖', parentId: 'c1' }],
    goals: [] as any[],
    members: [{ id: 'u1', name: '爸爸' }, { id: 'u2', name: '妈妈' }],
  };

  it('收支与结余', () => {
    const r = assembleFamilyReview({
      ...base,
      bills: [
        { id: 'b1', userId: 'u1', type: 'income', amount: D(10000), categoryId: 'c1', isTransfer: false, source: 'manual', date: new Date(2025, 5, 1) },
        { id: 'b2', userId: 'u2', type: 'expense', amount: D(3000), categoryId: 'c1', isTransfer: false, source: 'manual', date: new Date(2025, 5, 2) },
        { id: 'b3', userId: 'u2', type: 'expense', amount: D(1000), categoryId: 'c1', isTransfer: true, source: 'manual', date: new Date(2025, 5, 3) },
      ],
    });
    expect(r.income).toBe(10000);
    expect(r.expense).toBe(3000); // 转账被排除
    expect(r.net).toBe(7000);
    expect(r.billCount).toBe(2); // 转账不计入 countable
  });

  it('成员贡献按支出降序', () => {
    const r = assembleFamilyReview({
      ...base,
      bills: [
        { id: 'b1', userId: 'u1', type: 'expense', amount: D(500), categoryId: 'c1', isTransfer: false, source: 'manual', date: new Date(2025, 5, 1) },
        { id: 'b2', userId: 'u2', type: 'expense', amount: D(900), categoryId: 'c1', isTransfer: false, source: 'manual', date: new Date(2025, 5, 2) },
      ],
    });
    expect(r.memberContributions.map((m) => m.userId)).toEqual(['u2', 'u1']);
    expect(r.memberContributions[0].name).toBe('妈妈');
  });

  it('预算超支含子分类归并', () => {
    const r = assembleFamilyReview({
      ...base,
      bills: [
        { id: 'b1', userId: 'u1', type: 'expense', amount: D(600), categoryId: 'c1', isTransfer: false, source: 'manual', date: new Date(2025, 5, 1) },
        { id: 'b2', userId: 'u1', type: 'expense', amount: D(600), categoryId: 'c2', isTransfer: false, source: 'manual', date: new Date(2025, 5, 2) },
      ],
      budgets: [{ categoryId: 'c1', amount: D(1000) }],
    });
    expect(r.budgetOverspend).toHaveLength(1);
    expect(r.budgetOverspend[0].spent).toBe(1200); // 餐饮 600 + 外卖 600
    expect(r.budgetOverspend[0].over).toBe(200);
  });

  it('stock 纸面盈亏不计入', () => {
    const r = assembleFamilyReview({
      ...base,
      bills: [
        { id: 'b1', userId: 'u1', type: 'expense', amount: D(999), categoryId: 'c1', isTransfer: false, source: 'stock', date: new Date(2025, 5, 1) },
      ],
    });
    expect(r.expense).toBe(0);
    expect(r.billCount).toBe(0);
  });

  it('familyMonthKey 补零', () => {
    expect(familyMonthKey(new Date(2025, 0, 1))).toBe('2025-01');
    expect(familyMonthKey(new Date(2025, 11, 1))).toBe('2025-12');
  });
});

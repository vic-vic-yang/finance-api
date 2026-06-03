import { detectLargeExpense } from './large-expense';
import { DetectorInput, DetectorBill } from './types';

const base = (over: Partial<DetectorInput>): DetectorInput => ({
  periodKey: '2026-06', now: new Date('2026-06-15'),
  bills: [], recentBills: [], accounts: [], budgets: [], goals: [],
  recentExpenseByAccount: {}, lastOutflowDays: {}, ...over,
});
const eb = (id: string, amount: number, categoryName = '餐饮', daysAgo = 1): DetectorBill => ({
  id, accountId: 'a', categoryId: 'c1', categoryName, type: 'expense',
  amount, date: new Date(2026, 5, 15 - daysAgo), externalId: null, isTransfer: false,
});

describe('detectLargeExpense', () => {
  it('超绝对阈值(1000)的当期支出产出建议', () => {
    const out = detectLargeExpense(base({ bills: [eb('1', 1200)], recentBills: [eb('1', 1200)] }));
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('large_expense');
    expect(out[0].dedupeKey).toBe('large:1');
    expect((out[0].actionParams as any).billId).toBe('1');
  });
  it('超分类近 3 月均值 ×3 也产出', () => {
    const recent = [eb('h1', 100, '餐饮', 40), eb('h2', 100, '餐饮', 50)];
    const cur = eb('big', 400, '餐饮', 1); // 均值100, 400>300
    const out = detectLargeExpense(base({ bills: [cur], recentBills: [...recent, cur] }));
    expect(out.map((p) => (p.actionParams as any).billId)).toContain('big');
  });
  it('普通小额不产出', () => {
    const out = detectLargeExpense(base({ bills: [eb('1', 30)], recentBills: [eb('1', 30)] }));
    expect(out).toHaveLength(0);
  });
  it('转账(isTransfer)不计入', () => {
    const t = { ...eb('t', 5000), isTransfer: true };
    expect(detectLargeExpense(base({ bills: [t], recentBills: [t] }))).toHaveLength(0);
  });
});

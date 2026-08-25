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
  it('超分类近 3 月均值 ×5 且金额 ≥500 才产出相对异常', () => {
    // 均值 100，需 ≥3 笔基线；600 > 100×5 且 ≥500
    const recent = [
      eb('h1', 100, '餐饮', 40),
      eb('h2', 100, '餐饮', 50),
      eb('h3', 100, '餐饮', 60),
    ];
    const cur = eb('big', 600, '餐饮', 1);
    const out = detectLargeExpense(base({ bills: [cur], recentBills: [...recent, cur] }));
    expect(out.map((p) => (p.actionParams as any).billId)).toContain('big');
  });
  it('倍数虽高但绝对金额 <500 的日常消费不提示（如买菜 180）', () => {
    const recent = [
      eb('h1', 37, '日用', 40),
      eb('h2', 37, '日用', 50),
      eb('h3', 37, '日用', 60),
    ];
    const cur = eb('small', 180, '日用', 1); // ≈4.9 倍，但不足 500
    const out = detectLargeExpense(base({ bills: [cur], recentBills: [...recent, cur] }));
    expect(out).toHaveLength(0);
  });
  it('基线不足 3 笔时不算相对异常（避免偶然均值）', () => {
    const recent = [eb('h1', 100, '餐饮', 40), eb('h2', 100, '餐饮', 50)];
    const cur = eb('big', 600, '餐饮', 1);
    const out = detectLargeExpense(base({ bills: [cur], recentBills: [...recent, cur] }));
    expect(out).toHaveLength(0);
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

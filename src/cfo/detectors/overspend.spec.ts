import { detectOverspend } from './overspend';
import { DetectorInput, DetectorBudget } from './types';

const base = (b: DetectorBudget[]): DetectorInput => ({
  periodKey: '2026-06', now: new Date('2026-06-15'),
  bills: [], recentBills: [], accounts: [], budgets: b, goals: [],
  recentExpenseByAccount: {}, lastOutflowDays: {},
});
const bg = (id: string, limit: number, spent: number): DetectorBudget =>
  ({ id, categoryId: 'c1', categoryName: '餐饮', period: 'MONTHLY', limit, spent });

describe('detectOverspend', () => {
  it('已用 >= 90% 产出建议,动作为调预算', () => {
    const out = detectOverspend(base([bg('b1', 1000, 950)]));
    expect(out).toHaveLength(1);
    expect(out[0].actionKind).toBe('adjust_budget');
    expect((out[0].actionParams as any).budgetId).toBe('b1');
    expect((out[0].actionParams as any).newLimit).toBe(Math.round(950 * 1.1));
    expect(out[0].dedupeKey).toBe('overspend:b1:2026-06');
  });
  it('已用 < 90% 不产出', () => {
    expect(detectOverspend(base([bg('b1', 1000, 500)]))).toHaveLength(0);
  });
  it('limit<=0 跳过', () => {
    expect(detectOverspend(base([bg('b1', 0, 500)]))).toHaveLength(0);
  });
});

import { BriefingFacts } from './briefing.facts';
import { notablePoints, renderTemplateBriefing } from './briefing.template';

function fullFacts(over: Partial<BriefingFacts> = {}): BriefingFacts {
  return {
    weekStart: '2026-07-20',
    weekEnd: '2026-07-26',
    prevWeekStart: '2026-07-13',
    prevWeekEnd: '2026-07-19',
    billCount: 12,
    expense: 1234.5,
    income: 5000,
    prevExpense: 1100,
    prevIncome: 5000,
    expenseChangePct: 12.2,
    incomeChangePct: 0,
    topExpenseCategories: [
      { categoryId: 'c1', name: '餐饮', amount: 456 },
      { categoryId: 'c2', name: '交通', amount: 200 },
    ],
    largeExpenses: [
      { categoryId: 'c3', categoryName: '购物', amount: 2000, date: '2026-07-23' },
    ],
    budgetOverspend: [
      { categoryId: 'c4', name: '交通', budget: 300, spent: 420, over: 120 },
    ],
    upcomingRecurring: [
      { categoryId: 'c1', categoryName: '餐饮', amount: 25, type: 'expense', nextDate: '2026-07-28' },
    ],
    healthScore: 82,
    advice: '「交通」预算已超支 ¥120.00，本周这类开销先缓一缓。',
    ...over,
  };
}

describe('renderTemplateBriefing', () => {
  it('完整 facts：总结 + 值得注意 + 建议 三段齐全', () => {
    const text = renderTemplateBriefing(fullFacts());
    const lines = text.split('\n');
    expect(lines[0]).toContain('上周支出 ¥1,234.50');
    expect(lines[0]).toContain('比上上周多 12.2%');
    expect(lines[0]).toContain('收入 ¥5,000.00');
    // 值得注意（最多 3 条，· 开头）
    const points = lines.filter((l) => l.startsWith('· '));
    expect(points.length).toBeGreaterThan(0);
    expect(points.length).toBeLessThanOrEqual(3);
    expect(points.join('\n')).toContain('预算已超支');
    expect(points.join('\n')).toContain('大额支出');
    // 建议
    expect(lines[lines.length - 1]).toMatch(/^建议：/);
  });

  it('值得注意最多 3 条，按重要性排序（超支 > 大额 > Top 分类 > 周期扣款）', () => {
    const points = notablePoints(fullFacts());
    expect(points).toHaveLength(3);
    expect(points[0]).toContain('预算已超支');
    expect(points[1]).toContain('大额支出');
    expect(points[2]).toContain('餐饮');
  });

  it('无值得注意事项时：只有总结 + 建议', () => {
    const text = renderTemplateBriefing(
      fullFacts({
        topExpenseCategories: [],
        largeExpenses: [],
        budgetOverspend: [],
        upcomingRecurring: [],
      }),
    );
    expect(text).not.toContain('· ');
    expect(text).toContain('建议：');
  });

  it('上上周无数据（环比 null）：总结不提环比', () => {
    const text = renderTemplateBriefing(fullFacts({ expenseChangePct: null }));
    expect(text.split('\n')[0]).not.toContain('比上上周');
  });

  it('收入为 0：总结不提收入', () => {
    const text = renderTemplateBriefing(fullFacts({ income: 0 }));
    expect(text.split('\n')[0]).not.toContain('收入');
  });

  it('任意组合下输出不含 undefined / NaN / null 字样', () => {
    const variants: Partial<BriefingFacts>[] = [
      {},
      { expenseChangePct: null, incomeChangePct: null },
      { income: 0, healthScore: null },
      { topExpenseCategories: [], largeExpenses: [], budgetOverspend: [], upcomingRecurring: [] },
      { expense: 0, prevExpense: 0 },
    ];
    for (const v of variants) {
      const text = renderTemplateBriefing(fullFacts(v));
      expect(text).not.toMatch(/undefined|NaN|\bnull\b/);
      expect(text.length).toBeGreaterThan(10);
    }
  });
});

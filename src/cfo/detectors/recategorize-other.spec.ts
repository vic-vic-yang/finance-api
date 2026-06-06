import { detectRecategorizeOther } from './recategorize-other';
import { DetectorInput } from './types';

const base = (over: Partial<DetectorInput>): DetectorInput => ({
  periodKey: '2026-06', now: new Date('2026-06-15'),
  bills: [], recentBills: [], accounts: [], budgets: [], goals: [],
  recentExpenseByAccount: {}, lastOutflowDays: {}, ...over,
});
const bill = (id: string, categoryName: string) => ({
  id, accountId: 'a', categoryId: 'c-' + categoryName, categoryName,
  type: 'expense' as const, amount: 10, date: new Date('2026-06-10'),
  externalId: null, isTransfer: false,
});

describe('detectRecategorizeOther', () => {
  it('其他账单 >= 阈值(3) 时产出一条建议', () => {
    const input = base({ bills: [bill('1', '其他'), bill('2', '其他'), bill('3', '其它')] });
    const out = detectRecategorizeOther(input);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('recategorize_other');
    expect(out[0].actionKind).toBe('review_uncategorized');
    expect(out[0].requiresClient).toBe(true);
    expect((out[0].actionParams as any).count).toBe(3);
    expect(out[0].dedupeKey).toBe('recat:2026-06');
  });
  it('其他账单 < 阈值 时不产出', () => {
    expect(detectRecategorizeOther(base({ bills: [bill('1', '其他')] }))).toHaveLength(0);
  });
  it('非其他分类不计入', () => {
    const input = base({ bills: [bill('1', '餐饮'), bill('2', '餐饮'), bill('3', '餐饮')] });
    expect(detectRecategorizeOther(input)).toHaveLength(0);
  });
});

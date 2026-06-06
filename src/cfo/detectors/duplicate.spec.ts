import { detectDuplicate } from './duplicate';
import { DetectorInput, DetectorBill } from './types';

const base = (recent: DetectorBill[]): DetectorInput => ({
  periodKey: '2026-06', now: new Date('2026-06-15'),
  bills: [], recentBills: recent, accounts: [], budgets: [], goals: [],
  recentExpenseByAccount: {}, lastOutflowDays: {},
});
const b = (id: string, min: number, ext: string | null = null): DetectorBill => ({
  id, accountId: 'a', categoryId: 'c', categoryName: '餐饮', type: 'expense',
  amount: 50, date: new Date(2026, 5, 10, 12, min), externalId: ext, isTransfer: false,
});

describe('detectDuplicate', () => {
  it('同账户同额、时间差≤10分钟 → 疑似重复,删较晚一笔', () => {
    const out = detectDuplicate(base([b('1', 0), b('2', 5)]));
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('duplicate_charge');
    expect((out[0].actionParams as any).billId).toBe('2'); // 较晚的
    expect(out[0].dedupeKey).toBe('dup:1:2');
  });
  it('两笔订单号不同 → 不算重复', () => {
    expect(detectDuplicate(base([b('1', 0, 'A'), b('2', 5, 'B')]))).toHaveLength(0);
  });
  it('时间差>10分钟 → 不算', () => {
    expect(detectDuplicate(base([b('1', 0), b('2', 20)]))).toHaveLength(0);
  });
});

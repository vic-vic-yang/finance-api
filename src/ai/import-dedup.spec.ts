import { normalizeDirection, dedupDrafts, extKey } from './import-dedup';

describe('normalizeDirection', () => {
  it('支出/收入/不计收支 → expense/income/transfer', () => {
    expect(normalizeDirection('支出')).toBe('expense');
    expect(normalizeDirection('收入')).toBe('income');
    expect(normalizeDirection('不计收支')).toBe('transfer');
    expect(normalizeDirection('其他')).toBe('expense');
    expect(normalizeDirection(undefined)).toBe('expense');
  });
});

describe('dedupDrafts', () => {
  const base = { amount: 2, date: '2026-05-20T19:00:00.000Z', type: 'expense' };
  it('有 externalId：订单号+金额+方向都命中才算重复', () => {
    const drafts = [{ ...base, externalId: 'A' }, { ...base, externalId: 'B' }];
    const r = dedupDrafts(drafts as any, new Set([extKey('A', 2, 'expense')]), new Set());
    expect(r.kept.map((d: any) => d.externalId)).toEqual(['B']);
    expect(r.skipped).toBe(1);
  });
  it('externalId 相同但金额不同 → 订单号被贴错，不算重复', () => {
    // 回归用例：库里 5-11 的 7104.17 被错贴了订单号 X，
    // 真正持订单号 X 的 5641.59 重导入时不应被误杀
    const drafts = [{ ...base, amount: 5641.59, type: 'income', externalId: 'X' }];
    const r = dedupDrafts(drafts as any, new Set([extKey('X', 7104.17, 'income')]), new Set());
    expect(r.kept.length).toBe(1);
    expect(r.skipped).toBe(0);
  });
  it('externalId+金额相同但方向相反 → 付款与退款是两笔，都保留', () => {
    // 回归用例：快捷支付 -67.90 与 快捷退款 +67.90 共用订单号 187834790001
    const drafts = [
      { ...base, amount: 67.9, type: 'expense', externalId: '187834790001' },
      { ...base, amount: 67.9, type: 'income', externalId: '187834790001' },
    ];
    const r = dedupDrafts(
      drafts as any,
      new Set([extKey('187834790001', 67.9, 'expense')]),
      new Set(),
    );
    expect(r.kept.length).toBe(1);
    expect((r.kept[0] as any).type).toBe('income');
    expect(r.skipped).toBe(1);
  });
  it('两份草稿内部 externalId 完全重复，只保留第一条', () => {
    const drafts = [{ ...base, externalId: 'A' }, { ...base, externalId: 'A' }];
    const r = dedupDrafts(drafts as any, new Set(), new Set());
    expect(r.kept.length).toBe(1);
    expect(r.skipped).toBe(1);
  });
  it('无 externalId：退回 日期+金额 近似去重', () => {
    const drafts = [{ ...base }, { ...base }];
    const key = `dat|${new Date(base.date).getTime()}|2|expense`;
    const r = dedupDrafts(drafts as any, new Set(), new Set([key]));
    expect(r.kept.length).toBe(0);
    expect(r.skipped).toBe(2);
  });
});

import { normalizeDirection, dedupDrafts } from './import-dedup';

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
  const base = { amount: 2, date: '2026-05-20T19:00:00.000Z' };
  it('有 externalId：命中已存在的 externalId 跳过', () => {
    const drafts = [{ ...base, externalId: 'A' }, { ...base, externalId: 'B' }];
    const r = dedupDrafts(drafts as any, new Set(['A']), new Set());
    expect(r.kept.map((d: any) => d.externalId)).toEqual(['B']);
    expect(r.skipped).toBe(1);
  });
  it('两份草稿内部 externalId 重复，只保留第一条', () => {
    const drafts = [{ ...base, externalId: 'A' }, { ...base, externalId: 'A' }];
    const r = dedupDrafts(drafts as any, new Set(), new Set());
    expect(r.kept.length).toBe(1);
    expect(r.skipped).toBe(1);
  });
  it('无 externalId：退回 日期+金额 近似去重', () => {
    const drafts = [{ ...base }, { ...base }];
    const dak = new Set([`${new Date(base.date).getTime()}|2`]);
    const r = dedupDrafts(drafts as any, new Set(), dak);
    expect(r.kept.length).toBe(0);
    expect(r.skipped).toBe(2);
  });
});

import { buildReconcileDrafts } from './reconcile-actions';

describe('buildReconcileDrafts', () => {
  it('余额漂移(warning) → reconcile_balance', () => {
    const drafts = buildReconcileDrafts([
      {
        key: 'balanceDrift',
        items: [{ accountId: 'a1', drift: 12.5, expected: 100, hasStock: false, severity: 'warning' }],
      },
    ]);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].actionKind).toBe('reconcile_balance');
    expect(drafts[0].actionParams).toEqual({ accountId: 'a1', balance: 100 });
    expect(drafts[0].requiresClient).toBe(false);
  });

  it('info 级 / 含股票 → 跳过', () => {
    const drafts = buildReconcileDrafts([
      { key: 'balanceDrift', items: [
        { accountId: 'a1', drift: 1, expected: 10, hasStock: true, severity: 'info' },
        { accountId: 'a2', drift: 5, expected: 10, hasStock: true, severity: 'warning' },
      ] },
    ]);
    expect(drafts).toHaveLength(0);
  });

  it('疑似重复 → delete_bill 删除较晚腿', () => {
    const drafts = buildReconcileDrafts([
      { key: 'suspectedDuplicates', items: [
        { type: 'expense', amount: 50, bills: [{ id: 'b1' }, { id: 'b2' }], severity: 'warning' },
      ] },
    ]);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].actionKind).toBe('delete_bill');
    expect(drafts[0].actionParams).toEqual({ billId: 'b2' });
  });

  it('周期缺记 → create_missing_recurring (requiresClient)', () => {
    const drafts = buildReconcileDrafts([
      { key: 'recurringMissing', items: [
        { recurringId: 'r1', amount: 20, dueDate: '2025-06-01T00:00:00.000Z', severity: 'info' },
      ] },
    ]);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].actionKind).toBe('create_missing_recurring');
    expect(drafts[0].requiresClient).toBe(true);
  });

  it('转账缺腿 → delete_bill', () => {
    const drafts = buildReconcileDrafts([
      { key: 'transferOrphans', items: [
        { billId: 'b9', amount: 30, severity: 'warning' },
      ] },
    ]);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].actionKind).toBe('delete_bill');
    expect(drafts[0].actionParams).toEqual({ billId: 'b9' });
  });
});

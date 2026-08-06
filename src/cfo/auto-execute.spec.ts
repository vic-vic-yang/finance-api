import {
  AUTO_EXECUTABLE_ACTIONS,
  AUTO_EXECUTE_DAILY_LIMIT,
  canAutoExecute,
  isAutoExecutableAction,
} from './auto-execute';

const pending = (over: Record<string, unknown> = {}) => ({
  status: 'pending',
  actionKind: 'adjust_budget',
  requiresClient: false,
  severity: 'warning',
  ...over,
});

describe('isAutoExecutableAction', () => {
  it('白名单内动作放行', () => {
    expect(isAutoExecutableAction('adjust_budget')).toBe(true);
    expect(isAutoExecutableAction('recategorize_bill')).toBe(true);
    expect(AUTO_EXECUTABLE_ACTIONS).toContain('adjust_budget');
    expect(AUTO_EXECUTABLE_ACTIONS).toContain('recategorize_bill');
  });

  it('高危与未知动作拒绝', () => {
    expect(isAutoExecutableAction('delete_bill')).toBe(false);
    expect(isAutoExecutableAction('allocate_to_goal')).toBe(false);
    expect(isAutoExecutableAction('')).toBe(false);
    expect(isAutoExecutableAction('ADJUST_BUDGET')).toBe(false);
  });

  it('每日上限为 5', () => {
    expect(AUTO_EXECUTE_DAILY_LIMIT).toBe(5);
  });
});

describe('canAutoExecute', () => {
  it('白名单动作 + pending + 非客户端参与 + 非 critical → 放行', () => {
    expect(canAutoExecute('adjust_budget', pending())).toBe(true);
    expect(
      canAutoExecute(
        'recategorize_bill',
        pending({ actionKind: 'recategorize_bill', severity: 'info' }),
      ),
    ).toBe(true);
  });

  it('高危动作即使其它条件全满足也拒绝', () => {
    expect(
      canAutoExecute('delete_bill', pending({ actionKind: 'delete_bill' })),
    ).toBe(false);
  });

  it('动作类型与提议不一致 → 拒绝', () => {
    expect(
      canAutoExecute(
        'adjust_budget',
        pending({ actionKind: 'recategorize_bill' }),
      ),
    ).toBe(false);
  });

  it('非 pending（已决定）→ 拒绝', () => {
    for (const status of ['approved', 'dismissed', 'snoozed', 'done']) {
      expect(canAutoExecute('adjust_budget', pending({ status }))).toBe(false);
    }
  });

  it('requiresClient → 拒绝', () => {
    expect(
      canAutoExecute('adjust_budget', pending({ requiresClient: true })),
    ).toBe(false);
  });

  it('critical 级提议永远需要人工确认', () => {
    expect(
      canAutoExecute('adjust_budget', pending({ severity: 'critical' })),
    ).toBe(false);
  });

  it('proposal 为空 → 拒绝', () => {
    expect(canAutoExecute('adjust_budget', null)).toBe(false);
    expect(canAutoExecute('adjust_budget', undefined)).toBe(false);
  });
});

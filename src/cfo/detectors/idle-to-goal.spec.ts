import { detectIdleToGoal } from './idle-to-goal';
import { DetectorInput } from './types';

const base = (over: Partial<DetectorInput>): DetectorInput => ({
  periodKey: '2026-06', now: new Date('2026-06-15'),
  bills: [], recentBills: [], accounts: [], budgets: [], goals: [],
  recentExpenseByAccount: {}, lastOutflowDays: {}, ...over,
});

describe('detectIdleToGoal', () => {
  it('账户闲置且有未达标目标 → 产出转账建议', () => {
    const out = detectIdleToGoal(base({
      accounts: [{ id: 'bank', accountType: 'BANK', balance: 20000 }],
      goals: [{ id: 'g1', accountId: 'goal-acc', target: 8000, saved: 6500 }],
      recentExpenseByAccount: { bank: 3000 },
      lastOutflowDays: { bank: 40 },
    }));
    expect(out).toHaveLength(1);
    expect(out[0].actionKind).toBe('allocate_to_goal');
    expect(out[0].requiresClient).toBe(true);
    const p = out[0].actionParams as any;
    expect(p.fromAccountId).toBe('bank');
    expect(p.toAccountId).toBe('goal-acc');
    expect(p.goalId).toBe('g1');
    expect(p.amount).toBe(1500); // min(缺口1500, 闲钱可动)
    expect(out[0].dedupeKey).toBe('idle:bank:g1');
  });
  it('近 30 天有流出 → 不算闲钱', () => {
    expect(detectIdleToGoal(base({
      accounts: [{ id: 'bank', accountType: 'BANK', balance: 20000 }],
      goals: [{ id: 'g1', accountId: 'goal-acc', target: 8000, saved: 6500 }],
      recentExpenseByAccount: { bank: 3000 }, lastOutflowDays: { bank: 5 },
    }))).toHaveLength(0);
  });
  it('目标无绑定账户 → 跳过', () => {
    expect(detectIdleToGoal(base({
      accounts: [{ id: 'bank', accountType: 'BANK', balance: 20000 }],
      goals: [{ id: 'g1', accountId: null, target: 8000, saved: 1 }],
      lastOutflowDays: { bank: 40 },
    }))).toHaveLength(0);
  });
});

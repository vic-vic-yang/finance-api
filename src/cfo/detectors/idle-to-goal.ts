import { DetectorInput, ProposalDraft } from './types';

const IDLE_DAYS = 30;
const MIN_IDLE_BALANCE = 5000;
const MIN_SUGGEST = 100;

export function detectIdleToGoal(input: DetectorInput): ProposalDraft[] {
  // 取一个最闲的活钱账户(BANK/VIRTUAL、余额高、久未流出)
  const idle = input.accounts
    .filter((a) => ['BANK', 'VIRTUAL', 'CASH'].includes(a.accountType))
    .filter((a) => a.balance >= MIN_IDLE_BALANCE)
    .filter((a) => (input.lastOutflowDays[a.id] ?? 0) >= IDLE_DAYS)
    .sort((x, y) => y.balance - x.balance)[0];
  if (!idle) return [];

  // 取一个最接近达成、且已绑定账户的未达标目标
  const goal = input.goals
    .filter((g) => g.accountId && g.saved < g.target)
    .sort((x, y) => (y.saved / y.target) - (x.saved / x.target))[0];
  if (!goal) return [];

  const gap = goal.target - goal.saved;
  // 闲钱可动:余额减去近月支出做缓冲,保守取整到百
  const movable = Math.max(0, idle.balance - (input.recentExpenseByAccount[idle.id] ?? 0));
  const amount = Math.floor(Math.min(gap, movable) / 100) * 100;
  if (amount < MIN_SUGGEST) return [];

  return [{
    type: 'idle_to_goal',
    severity: 'info',
    title: `有 ¥${amount} 闲钱可以去攒目标`,
    body: `有一笔钱躺着 ${input.lastOutflowDays[idle.id]} 天没动了，要不要转 ¥${amount} 去你的储蓄目标？`,
    actionKind: 'allocate_to_goal',
    actionParams: {
      fromAccountId: idle.id, toAccountId: goal.accountId, goalId: goal.id, amount,
    },
    requiresClient: true,
    evidenceRefs: { fromAccountId: idle.id, goalId: goal.id },
    dedupeKey: `idle:${idle.id}:${goal.id}`,
  }];
}

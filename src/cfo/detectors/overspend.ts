import { DetectorInput, ProposalDraft } from './types';

const RATE = 0.9;

export function detectOverspend(input: DetectorInput): ProposalDraft[] {
  const out: ProposalDraft[] = [];
  for (const b of input.budgets) {
    if (b.limit <= 0) continue;
    if (b.spent < b.limit * RATE) continue;
    const pct = Math.round((b.spent / b.limit) * 100);
    out.push({
      type: 'budget_overspend',
      severity: b.spent > b.limit ? 'critical' : 'warning',
      title: `${b.categoryName}预算已用 ${pct}%`,
      body: `${b.categoryName}本期已用 ¥${b.spent.toFixed(0)} / ¥${b.limit.toFixed(0)}。要把下期预算调到 ¥${Math.round(b.spent * 1.1)} 吗？`,
      actionKind: 'adjust_budget',
      actionParams: { budgetId: b.id, newLimit: Math.round(b.spent * 1.1) },
      requiresClient: false,
      evidenceRefs: { budgetId: b.id },
      dedupeKey: `overspend:${b.id}:${input.periodKey}`,
    });
  }
  return out;
}

import { DetectorInput, ProposalDraft } from './types';

const WINDOW_MS = 10 * 60 * 1000;

export function detectDuplicate(input: DetectorInput): ProposalDraft[] {
  const out: ProposalDraft[] = [];
  const cand = input.recentBills.filter((x) => !x.isTransfer);
  for (let i = 0; i < cand.length; i++) {
    for (let j = i + 1; j < cand.length; j++) {
      const a = cand[i], b = cand[j];
      if (a.accountId !== b.accountId) continue;
      if (a.amount !== b.amount) continue;
      // 两边都有订单号且不同 → 真两笔
      if (a.externalId && b.externalId && a.externalId !== b.externalId) continue;
      if (Math.abs(a.date.getTime() - b.date.getTime()) > WINDOW_MS) continue;
      const [early, late] = a.date <= b.date ? [a, b] : [b, a];
      out.push({
        type: 'duplicate_charge',
        severity: 'warning',
        title: `疑似重复扣费 ¥${a.amount.toFixed(2)}`,
        body: `同一账户在 10 分钟内有两笔相同金额 ¥${a.amount.toFixed(2)} 的支出，疑似重复。要删掉较晚的一笔吗？`,
        actionKind: 'delete_bill',
        actionParams: { billId: late.id },
        requiresClient: false,
        evidenceRefs: { billIds: [early.id, late.id] },
        dedupeKey: `dup:${early.id}:${late.id}`,
      });
    }
  }
  return out;
}

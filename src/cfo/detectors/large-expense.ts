import { DetectorInput, DetectorBill, ProposalDraft } from './types';

/** 绝对大额：超过此金额必提示（不论分类均值） */
const ABS_THRESHOLD = 1000;
/** 相对异常：超过分类历史均值的倍数才算尖峰 */
const RATIO = 5;
/** 相对异常的金额下限——小额即便倍数高也不烦（买菜 180 相对平时 37 倍高，但仍是日常） */
const OUTLIER_MIN = 500;
/** 算分类均值至少要有几笔历史，避免两笔偶然均值把正常消费打成异常 */
const MIN_BASELINE_N = 3;

export function detectLargeExpense(input: DetectorInput): ProposalDraft[] {
  // 近 3 月各分类均值(基线用 recentBills 里的支出,排除转账;排除当期账单本身,避免自比)
  const currentIds = new Set(input.bills.map((b) => b.id));
  const sums: Record<string, { total: number; n: number }> = {};
  for (const b of input.recentBills) {
    if (b.type !== 'expense' || b.isTransfer) continue;
    if (currentIds.has(b.id)) continue;
    (sums[b.categoryId] ??= { total: 0, n: 0 });
    sums[b.categoryId].total += b.amount;
    sums[b.categoryId].n += 1;
  }
  const out: ProposalDraft[] = [];
  for (const b of input.bills) {
    if (b.type !== 'expense' || b.isTransfer) continue;
    const stat = sums[b.categoryId];
    const mean = stat && stat.n > 0 ? stat.total / stat.n : 0;
    const isHuge = b.amount > ABS_THRESHOLD;
    const isOutlier =
      mean > 0 &&
      (stat?.n ?? 0) >= MIN_BASELINE_N &&
      b.amount >= OUTLIER_MIN &&
      b.amount > mean * RATIO;
    if (!isHuge && !isOutlier) continue;
    out.push({
      type: 'large_expense',
      severity: b.amount > 5000 ? 'critical' : 'warning',
      title: `一笔大额支出 ¥${b.amount.toFixed(2)}（${b.categoryName}）`,
      body: isOutlier && mean > 0
        ? `${b.categoryName}平时约 ¥${mean.toFixed(0)}，这笔是约 ${(b.amount / mean).toFixed(1)} 倍，确认一下？`
        : `${b.categoryName}的一笔大额支出，确认一下？`,
      actionKind: 'acknowledge',
      actionParams: { billId: b.id },
      requiresClient: false,
      evidenceRefs: { billId: b.id },
      dedupeKey: `large:${b.id}`,
    });
  }
  return out;
}

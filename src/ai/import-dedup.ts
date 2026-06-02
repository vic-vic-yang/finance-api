export type Direction = 'expense' | 'income' | 'transfer';

/** 支付宝/微信「收/支」列 → 内部方向。不计收支=转账，其余兜底 expense
 *
 *  同时支持中文（"收入"/"支出"/"不计收支"）和英文（"income"/"expense"/"transfer"）
 *  输入——中文来自原始账单的"收/支"列，英文来自 LLM 的 direction 字段输出。 */
export function normalizeDirection(v: string | undefined | null): Direction {
  const s = (v ?? '').trim().toLowerCase();
  if (s.includes('不计') || s === 'transfer') return 'transfer';
  if (s.includes('收入') || s === '收' || s === 'income') return 'income';
  return 'expense';
}

interface DedupInput {
  amount: number;
  date: string;
  externalId?: string;
}

/**
 * 去重：有 externalId 用 externalId 精确去重（已存在集合 + 本批内）；
 * 无 externalId 退回 日期(ms)+金额(Number归一) 近似去重。
 */
export function dedupDrafts<T extends DedupInput>(
  drafts: T[],
  existingExternalIds: Set<string>,
  existingDateAmountKeys: Set<string>,
): { kept: T[]; skipped: number } {
  const seenExt = new Set(existingExternalIds);
  const seenDak = new Set(existingDateAmountKeys);
  const kept: T[] = [];
  let skipped = 0;
  for (const d of drafts) {
    if (d.externalId) {
      if (seenExt.has(d.externalId)) { skipped++; continue; }
      seenExt.add(d.externalId);
      kept.push(d);
    } else {
      const key = `${new Date(d.date).getTime()}|${Number(d.amount)}`;
      if (seenDak.has(key)) { skipped++; continue; }
      seenDak.add(key);
      kept.push(d);
    }
  }
  return { kept, skipped };
}

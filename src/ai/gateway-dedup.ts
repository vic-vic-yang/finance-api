/** 银行流水里"走支付宝/微信"的网关行特征词（普通聚合器流水的对方是真实商户，不含这些） */
const GATEWAY_KEYWORDS = ['财付通', '支付宝', '微信支付', '微信'];

/** 该笔是否是"通过支付宝/微信网关支付"的银行行 */
export function isGatewayPayment(
  note?: string | null,
  counterparty?: string | null,
): boolean {
  const s = `${note ?? ''} ${counterparty ?? ''}`;
  return GATEWAY_KEYWORDS.some((k) => s.includes(k));
}

interface GwDraft {
  amount: number;
  date: string;
  note?: string | null;
  counterparty?: string | null;
}
interface AggBill {
  amount: number | { toString(): string };
  date: Date | string;
}

/**
 * 跨源去重：网关行若能在"已入库的聚合器账单(source∈alipay/wechat)"里找到
 * 同金额 + 日期在 ±windowDays 天内的，判为重复跳过；否则保留。非网关行一律保留。
 */
export function filterGatewayDups<T extends GwDraft>(
  drafts: T[],
  existingAgg: AggBill[],
  windowDays = 4,
): { kept: T[]; skipped: number } {
  const ms = windowDays * 86400000;
  const agg = existingAgg.map((b) => ({
    amount: Number(b.amount),
    t: new Date(b.date as any).getTime(),
  }));
  const kept: T[] = [];
  let skipped = 0;
  for (const d of drafts) {
    if (!isGatewayPayment(d.note, d.counterparty)) {
      kept.push(d);
      continue;
    }
    const dt = new Date(d.date).getTime();
    const amt = Number(d.amount);
    const dup = agg.some((a) => a.amount === amt && Math.abs(a.t - dt) <= ms);
    if (dup) {
      skipped++;
      continue;
    }
    kept.push(d);
  }
  return { kept, skipped };
}

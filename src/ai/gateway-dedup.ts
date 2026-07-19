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

/** 聚合器(微信/支付宝)流水里"绑银行卡支付"的付款方式特征（零钱/零钱通/余额宝等平台余额不含这些） */
const BANK_FUND_HINT = /银行|储蓄卡|信用卡|借记卡|贷记卡|银行卡/;

/** 该付款方式是否是"绑银行卡"而非平台余额（零钱/零钱通/余额宝） */
export function isBankFundedHint(hint?: string | null): boolean {
  const s = (hint ?? '').trim();
  if (!s) return false;
  return BANK_FUND_HINT.test(s);
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
  type?: string | null;
}

interface CrossDraft {
  amount: number;
  date: string;
  type?: string;
}

/**
 * 通用跨源去重：候选草稿若能在"已入库账单"里找到
 * 同方向（双方都有 type 时才校验）+ 同金额 + 日期差 ≤ windowDays 天的，判为重复跳过；
 * 非候选草稿一律保留。
 */
export function filterCrossDups<T extends CrossDraft>(
  drafts: T[],
  existing: AggBill[],
  windowDays: number,
  isCandidate: (d: T) => boolean,
): { kept: T[]; skipped: number } {
  const ms = windowDays * 86400000;
  const ex = existing.map((b) => ({
    amount: Number(b.amount),
    t: new Date(b.date as any).getTime(),
    type: b.type ?? undefined,
  }));
  const kept: T[] = [];
  let skipped = 0;
  for (const d of drafts) {
    if (!isCandidate(d)) {
      kept.push(d);
      continue;
    }
    const dt = new Date(d.date).getTime();
    const amt = Number(d.amount);
    const dup = ex.some(
      (a) =>
        a.amount === amt &&
        Math.abs(a.t - dt) <= ms &&
        (a.type === undefined || d.type === undefined || a.type === d.type),
    );
    if (dup) {
      skipped++;
      continue;
    }
    kept.push(d);
  }
  return { kept, skipped };
}

/**
 * 跨源去重（正向）：银行流水的网关行 vs 已入库的聚合器账单(source∈alipay/wechat)。
 * 同金额 + 日期在 ±windowDays 天内判为重复跳过；非网关行一律保留。
 */
export function filterGatewayDups<T extends GwDraft>(
  drafts: T[],
  existingAgg: AggBill[],
  windowDays = 4,
): { kept: T[]; skipped: number } {
  return filterCrossDups(drafts, existingAgg, windowDays, (d) =>
    isGatewayPayment(d.note, d.counterparty),
  );
}

/**
 * 股票平仓盈亏纯函数（Jest 单测覆盖）。
 *
 * 口径：
 *  - 总盈亏 = (平仓价 − 成本价) × 平仓股数
 *  - 与每日纸面结算（source='stock'，按 lastPrice→现价的市值变化）区分：
 *    平仓记「相对成本的已实现盈亏」；账户余额不因平仓盈亏账单再加减
 *    （关联账户已由纸面结算贴近市值，卖出后余额即约等于变现资金）。
 */

/** 金额两位小数（与结算服务一致；禁止业务层直接用裸浮点累加） */
export function roundMoney(x: number): number {
  return Math.round(x * 100) / 100;
}

export interface ClosePnlInput {
  buyPrice: number;
  shares: number;
  closePrice: number;
}

export interface ClosePnlResult {
  /** 成本合计 */
  cost: number;
  /** 卖出所得 */
  proceeds: number;
  /** 总盈亏（正=赚，负=亏） */
  totalPnl: number;
  /** 盈亏率（相对成本，%） */
  pnlPct: number;
}

/** 校验并计算全部平仓盈亏；非法输入返回 null */
export function calcClosePnl(input: ClosePnlInput): ClosePnlResult | null {
  const { buyPrice, shares, closePrice } = input;
  if (!(buyPrice > 0) || !(shares > 0) || !(closePrice > 0)) return null;
  if (!Number.isFinite(buyPrice) || !Number.isFinite(shares) || !Number.isFinite(closePrice)) {
    return null;
  }
  const cost = roundMoney(buyPrice * shares);
  const proceeds = roundMoney(closePrice * shares);
  const totalPnl = roundMoney(proceeds - cost);
  const pnlPct = cost > 0 ? roundMoney((totalPnl / cost) * 100) : 0;
  return { cost, proceeds, totalPnl, pnlPct };
}

/** 平仓前最后一次市值对齐：把 lastPrice 推到平仓价（无基准则 0） */
export function calcFinalMarkDelta(
  lastPrice: number | null | undefined,
  closePrice: number,
  shares: number,
): number {
  if (!(closePrice > 0) || !(shares > 0)) return 0;
  if (lastPrice == null || !(lastPrice > 0)) return 0;
  return roundMoney((closePrice - lastPrice) * shares);
}

/** 账单来源：已实现平仓盈亏（计入收支统计；不参与余额恒等式） */
export const STOCK_CLOSE_SOURCE = 'stock_close';

/** 纸面每日结算来源（不计收支；参与账户市值跟踪） */
export const STOCK_PAPER_SOURCE = 'stock';

/** 余额恒等式应排除的股票相关来源 */
export const STOCK_BALANCE_EXCLUDED_SOURCES = [
  STOCK_PAPER_SOURCE,
  STOCK_CLOSE_SOURCE,
] as const;

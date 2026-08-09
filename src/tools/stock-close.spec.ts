import {
  calcClosePnl,
  calcFinalMarkDelta,
  roundMoney,
  STOCK_CLOSE_SOURCE,
  STOCK_PAPER_SOURCE,
  STOCK_BALANCE_EXCLUDED_SOURCES,
} from './stock-close';

describe('calcClosePnl', () => {
  it('盈利：平仓价高于成本', () => {
    const r = calcClosePnl({ buyPrice: 10, shares: 100, closePrice: 12 });
    expect(r).toEqual({
      cost: 1000,
      proceeds: 1200,
      totalPnl: 200,
      pnlPct: 20,
    });
  });

  it('亏损：平仓价低于成本', () => {
    const r = calcClosePnl({ buyPrice: 10, shares: 100, closePrice: 8.5 });
    expect(r).toEqual({
      cost: 1000,
      proceeds: 850,
      totalPnl: -150,
      pnlPct: -15,
    });
  });

  it('持平：盈亏为 0', () => {
    const r = calcClosePnl({ buyPrice: 10, shares: 50, closePrice: 10 });
    expect(r?.totalPnl).toBe(0);
    expect(r?.pnlPct).toBe(0);
  });

  it('小数股数/价格按分位四舍五入', () => {
    // 10.123 * 3 = 30.369 → 30.37；10.5*3=31.5；差 1.13
    const r = calcClosePnl({ buyPrice: 10.123, shares: 3, closePrice: 10.5 });
    expect(r?.cost).toBe(30.37);
    expect(r?.proceeds).toBe(31.5);
    expect(r?.totalPnl).toBe(1.13);
  });

  it('非法输入返回 null', () => {
    expect(calcClosePnl({ buyPrice: 0, shares: 10, closePrice: 1 })).toBeNull();
    expect(calcClosePnl({ buyPrice: 10, shares: 0, closePrice: 1 })).toBeNull();
    expect(calcClosePnl({ buyPrice: 10, shares: 10, closePrice: -1 })).toBeNull();
    expect(
      calcClosePnl({ buyPrice: NaN, shares: 10, closePrice: 1 }),
    ).toBeNull();
  });
});

describe('calcFinalMarkDelta', () => {
  it('有基准价时对齐到平仓价', () => {
    expect(calcFinalMarkDelta(10, 12, 100)).toBe(200);
    expect(calcFinalMarkDelta(12, 10, 100)).toBe(-200);
  });

  it('无基准价不调整（避免把累计盈亏一次性灌进账户）', () => {
    expect(calcFinalMarkDelta(null, 12, 100)).toBe(0);
    expect(calcFinalMarkDelta(undefined, 12, 100)).toBe(0);
    expect(calcFinalMarkDelta(0, 12, 100)).toBe(0);
  });
});

describe('roundMoney / sources', () => {
  it('roundMoney 两位小数', () => {
    expect(roundMoney(1.234)).toBe(1.23);
    expect(roundMoney(1.236)).toBe(1.24);
    expect(roundMoney(-1.236)).toBe(-1.24);
  });

  it('余额恒等式排除纸面与平仓来源', () => {
    expect(STOCK_BALANCE_EXCLUDED_SOURCES).toContain(STOCK_PAPER_SOURCE);
    expect(STOCK_BALANCE_EXCLUDED_SOURCES).toContain(STOCK_CLOSE_SOURCE);
  });
});

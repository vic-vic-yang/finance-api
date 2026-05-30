import { isGatewayPayment, filterGatewayDups } from './gateway-dedup';

describe('isGatewayPayment', () => {
  it('对方/商户含网关词 → true', () => {
    expect(isGatewayPayment('财付通', '')).toBe(true);
    expect(isGatewayPayment('', '支付宝(中国)')).toBe(true);
    expect(isGatewayPayment('微信支付', null)).toBe(true);
  });
  it('普通商户 → false', () => {
    expect(isGatewayPayment('成都胜汇森商贸', '')).toBe(false);
    expect(isGatewayPayment('', '瑞幸咖啡')).toBe(false);
    expect(isGatewayPayment(null, null)).toBe(false);
  });
});

describe('filterGatewayDups', () => {
  const agg = [
    { amount: 24, date: '2026-05-26T16:24:29.000Z' },
  ];
  it('网关行 + 命中已有聚合器账单(同额, 日期±4天) → 跳过', () => {
    const drafts = [
      { amount: 24, date: '2026-05-27T10:00:00.000Z', counterparty: '财付通', note: '' },
    ];
    const r = filterGatewayDups(drafts as any, agg as any, 4);
    expect(r.kept.length).toBe(0);
    expect(r.skipped).toBe(1);
  });
  it('网关行但金额不同 → 保留', () => {
    const drafts = [
      { amount: 99, date: '2026-05-27T10:00:00.000Z', counterparty: '财付通', note: '' },
    ];
    const r = filterGatewayDups(drafts as any, agg as any, 4);
    expect(r.kept.length).toBe(1);
    expect(r.skipped).toBe(0);
  });
  it('网关行但日期超出窗口 → 保留', () => {
    const drafts = [
      { amount: 24, date: '2026-06-10T10:00:00.000Z', counterparty: '财付通', note: '' },
    ];
    const r = filterGatewayDups(drafts as any, agg as any, 4);
    expect(r.kept.length).toBe(1);
  });
  it('非网关行 → 一律保留（即使同额同日）', () => {
    const drafts = [
      { amount: 24, date: '2026-05-26T16:24:29.000Z', counterparty: '某商户', note: '' },
    ];
    const r = filterGatewayDups(drafts as any, agg as any, 4);
    expect(r.kept.length).toBe(1);
    expect(r.skipped).toBe(0);
  });
});

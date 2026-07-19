import { isGatewayPayment, isBankFundedHint, filterGatewayDups, filterCrossDups } from './gateway-dedup';

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

describe('isBankFundedHint', () => {
  it('银行卡类付款方式 → true', () => {
    expect(isBankFundedHint('招商银行储蓄卡(5476)')).toBe(true);
    expect(isBankFundedHint('工商银行信用卡')).toBe(true);
    expect(isBankFundedHint('建行借记卡(8899)')).toBe(true);
  });
  it('平台余额/空 → false', () => {
    expect(isBankFundedHint('零钱')).toBe(false);
    expect(isBankFundedHint('零钱通')).toBe(false);
    expect(isBankFundedHint('余额宝')).toBe(false);
    expect(isBankFundedHint('')).toBe(false);
    expect(isBankFundedHint(null)).toBe(false);
  });
});

describe('filterCrossDups（反向：聚合器绑卡支付 vs 银行/手动账单）', () => {
  // 已有：银行流水导入的招行账单（source=manual）
  const bankBills = [
    { amount: 3.6, date: '2026-07-01T00:00:00.000Z', type: 'expense' },
  ];
  const isCandidate = (d: any) =>
    d.direction !== 'transfer' && isBankFundedHint(d.fundingHint);

  it('微信草稿(招行卡付款) 命中银行已有账单(同向同额±4天) → 跳过', () => {
    const drafts = [
      { amount: 3.6, date: '2026-07-01T08:30:00.000Z', type: 'expense', fundingHint: '招商银行储蓄卡(5476)' },
    ];
    const r = filterCrossDups(drafts as any, bankBills as any, 4, isCandidate);
    expect(r.kept.length).toBe(0);
    expect(r.skipped).toBe(1);
  });
  it('微信零钱付款 → 不参与跨源去重，保留', () => {
    const drafts = [
      { amount: 3.6, date: '2026-07-01T08:30:00.000Z', type: 'expense', fundingHint: '零钱' },
    ];
    const r = filterCrossDups(drafts as any, bankBills as any, 4, isCandidate);
    expect(r.kept.length).toBe(1);
    expect(r.skipped).toBe(0);
  });
  it('方向不一致（银行支出 vs 草稿收入）→ 保留', () => {
    const drafts = [
      { amount: 3.6, date: '2026-07-01T08:30:00.000Z', type: 'income', fundingHint: '招商银行储蓄卡(5476)' },
    ];
    const r = filterCrossDups(drafts as any, bankBills as any, 4, isCandidate);
    expect(r.kept.length).toBe(1);
    expect(r.skipped).toBe(0);
  });
  it('direction=transfer（还款/转账）→ 不参与，保留', () => {
    const drafts = [
      { amount: 3.6, date: '2026-07-01T08:30:00.000Z', type: 'expense', direction: 'transfer', fundingHint: '招商银行储蓄卡(5476)' },
    ];
    const r = filterCrossDups(drafts as any, bankBills as any, 4, isCandidate);
    expect(r.kept.length).toBe(1);
    expect(r.skipped).toBe(0);
  });
});

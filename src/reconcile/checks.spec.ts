import { Prisma } from '@prisma/client';
import {
  checkBalanceDrift,
  checkSuspectedDuplicates,
  checkRecurringMissing,
  checkTransferOrphans,
  fuzzyCategoryMatch,
  worstSeverity,
  RcAccount,
  RcBill,
  RcRecurring,
} from './checks';

const D = (s: string) => new Date(s);
const dec = (s: string | number) => new Prisma.Decimal(s);

const acc = (
  id: string,
  initialBalance: string,
  balance: string,
): RcAccount => ({ id, initialBalance, balance });

const bill = (
  id: string,
  accountId: string,
  type: string,
  amount: string,
  date: string,
  extra: Partial<RcBill> = {},
): RcBill => ({
  id,
  accountId,
  categoryId: extra.categoryId ?? 'cat1',
  type,
  amount,
  date: D(date),
  isTransfer: extra.isTransfer ?? false,
  source: extra.source ?? 'manual',
  bankBalance: extra.bankBalance ?? null,
  externalId: extra.externalId ?? null,
});

// 2025-06 月界（本地时区构造，与 service 一致）
const JUNE_START = new Date(2025, 5, 1, 0, 0, 0, 0);
const JUNE_END = new Date(2025, 5, 30, 23, 59, 59, 999);

describe('checkBalanceDrift', () => {
  it('余额 = 初始 + 净流水 → 无条目', () => {
    const accounts = [acc('a1', '1000.00', '1300.00')];
    const net = new Map([['a1', dec('300.00')]]);
    expect(checkBalanceDrift(accounts, net, new Map())).toHaveLength(0);
  });

  it('偏差 ≥ 0.01 才报；临界 0.009 不报', () => {
    const accounts = [
      acc('a1', '100.00', '100.009'),
      acc('a2', '100.00', '100.01'),
    ];
    const out = checkBalanceDrift(accounts, new Map(), new Map());
    expect(out).toHaveLength(1);
    expect(out[0].accountId).toBe('a2');
  });

  it('drift = actual − expected，expected = initial + flowNet', () => {
    const accounts = [acc('a1', '500.00', '420.00')];
    const net = new Map([['a1', dec('50.00')]]);
    const out = checkBalanceDrift(accounts, net, new Map());
    expect(out).toHaveLength(1);
    expect(out[0].expected.toFixed(2)).toBe('550.00');
    expect(out[0].drift.toFixed(2)).toBe('-130.00');
    expect(out[0].severity).toBe('critical'); // 无股票且 |drift| ≥ 100
  });

  it('小偏差 warning；大偏差 critical；有股票流水降级 info', () => {
    const accounts = [
      acc('a1', '0', '50.00'),   // warning
      acc('a2', '0', '500.00'),  // critical
      acc('a3', '0', '500.00'),  // 有 stock → info
    ];
    const stockNet = new Map([['a3', dec('480.00')]]);
    const out = checkBalanceDrift(accounts, new Map(), stockNet);
    const byId = new Map(out.map((i) => [i.accountId, i]));
    expect(byId.get('a1')!.severity).toBe('warning');
    expect(byId.get('a2')!.severity).toBe('critical');
    expect(byId.get('a3')!.severity).toBe('info');
    expect(byId.get('a3')!.hasStock).toBe(true);
  });

  it('按偏差绝对值降序', () => {
    const accounts = [acc('a1', '0', '10'), acc('a2', '0', '99')];
    const out = checkBalanceDrift(accounts, new Map(), new Map());
    expect(out[0].accountId).toBe('a2');
  });

  it('流水缺失的账户按 0 净额处理（校准过余额会被发现）', () => {
    const out = checkBalanceDrift([acc('a1', '100', '100')], new Map(), new Map());
    expect(out).toHaveLength(0);
    const out2 = checkBalanceDrift([acc('a1', '100', '150')], new Map(), new Map());
    expect(out2).toHaveLength(1);
  });
});

describe('checkSuspectedDuplicates', () => {
  it('同账户同金额同方向 ±4 天内 → 报一对', () => {
    const bills = [
      bill('b1', 'a1', 'expense', '35.00', '2025-06-05T10:00:00'),
      bill('b2', 'a1', 'expense', '35.00', '2025-06-08T10:00:00'),
    ];
    const out = checkSuspectedDuplicates(bills, JUNE_START, JUNE_END);
    expect(out).toHaveLength(1);
    expect(out[0].first.id).toBe('b1');
    expect(out[0].second.id).toBe('b2');
    expect(out[0].gapDays).toBe(3);
  });

  it('差 5 天 > 窗口 → 不报', () => {
    const bills = [
      bill('b1', 'a1', 'expense', '35.00', '2025-06-01T10:00:00'),
      bill('b2', 'a1', 'expense', '35.00', '2025-06-06T10:00:01'),
    ];
    expect(checkSuspectedDuplicates(bills, JUNE_START, JUNE_END)).toHaveLength(0);
  });

  it('不同方向 / 不同金额 → 不报', () => {
    const base = bill('b1', 'a1', 'expense', '35.00', '2025-06-05T10:00:00');
    expect(
      checkSuspectedDuplicates(
        [base, bill('b3', 'a1', 'income', '35.00', '2025-06-06T10:00:00')],
        JUNE_START, JUNE_END,
      ),
    ).toHaveLength(0);
    expect(
      checkSuspectedDuplicates(
        [base, bill('b4', 'a1', 'expense', '35.01', '2025-06-06T10:00:00')],
        JUNE_START, JUNE_END,
      ),
    ).toHaveLength(0);
  });

  it('不同账户同金额同方向 ±4 天 → 报跨账户对（两人各记一笔）', () => {
    const bills = [
      bill('b1', 'a1', 'expense', '35.00', '2025-06-05T10:00:00'),
      bill('b2', 'a2', 'expense', '35.00', '2025-06-06T10:00:00'),
    ];
    const out = checkSuspectedDuplicates(bills, JUNE_START, JUNE_END);
    expect(out).toHaveLength(1);
    expect(out[0].crossAccount).toBe(true);
    expect(out[0].accountId).toBe('a1');
    expect(out[0].secondAccountId).toBe('a2');
  });

  it('跨账户对：外部单号不同不作反证（跨来源同一笔单号天然不同），照报', () => {
    const bills = [
      bill('b1', 'a1', 'expense', '5.40', '2025-06-16T08:00:00', { externalId: 'wx-001' }),
      bill('b2', 'a2', 'expense', '5.40', '2025-06-16T08:05:00', { externalId: 'bank-998' }),
    ];
    const out = checkSuspectedDuplicates(bills, JUNE_START, JUNE_END);
    expect(out).toHaveLength(1);
    expect(out[0].crossAccount).toBe(true);
  });

  it('跨账户对同样受 ±4 天窗口与月锚定约束', () => {
    const bills = [
      bill('b1', 'a1', 'expense', '35.00', '2025-05-28T10:00:00'),
      bill('b2', 'a2', 'expense', '35.00', '2025-05-29T10:00:00'), // 后腿不在 6 月
      bill('b3', 'a1', 'expense', '20.00', '2025-06-01T10:00:00'),
      bill('b4', 'a2', 'expense', '20.00', '2025-06-07T10:00:00'), // 差 6 天
    ];
    expect(checkSuspectedDuplicates(bills, JUNE_START, JUNE_END)).toHaveLength(0);
  });

  it('3 条连坐只报 2 对相邻对', () => {
    const bills = [
      bill('b1', 'a1', 'expense', '20.00', '2025-06-01T08:00:00'),
      bill('b2', 'a1', 'expense', '20.00', '2025-06-02T08:00:00'),
      bill('b3', 'a1', 'expense', '20.00', '2025-06-03T08:00:00'),
    ];
    const out = checkSuspectedDuplicates(bills, JUNE_START, JUNE_END);
    expect(out).toHaveLength(2);
  });

  it('source=stock 不参与；跨月边界对锚定在后腿月份', () => {
    const bills = [
      bill('s1', 'a1', 'income', '88.00', '2025-06-01T09:00:00', { source: 'stock' }),
      bill('s2', 'a1', 'income', '88.00', '2025-06-02T09:00:00', { source: 'stock' }),
      // 5/30 与 6/1：后腿在 6 月 → 本月报；后腿在 5 月的对本月不报
      bill('m1', 'a1', 'expense', '66.00', '2025-05-30T09:00:00'),
      bill('m2', 'a1', 'expense', '66.00', '2025-06-01T09:00:00'),
      bill('m3', 'a1', 'expense', '66.00', '2025-05-28T09:00:00'),
    ];
    const out = checkSuspectedDuplicates(bills, JUNE_START, JUNE_END);
    expect(out).toHaveLength(1);
    expect(out[0].second.id).toBe('m2');
    expect(out[0].first.id).toBe('m1');
  });

  it('两腿都有余额快照且不同 → 不是重复流水，不报', () => {
    const bills = [
      bill('b1', 'a1', 'expense', '35.00', '2025-06-05T10:00:00', { bankBalance: '965.00' }),
      bill('b2', 'a1', 'expense', '35.00', '2025-06-08T10:00:00', { bankBalance: '930.00' }),
    ];
    expect(checkSuspectedDuplicates(bills, JUNE_START, JUNE_END)).toHaveLength(0);
  });

  it('两腿余额相同 → 仍是疑似重复，照报', () => {
    const bills = [
      bill('b1', 'a1', 'expense', '35.00', '2025-06-05T10:00:00', { bankBalance: '965.00' }),
      bill('b2', 'a1', 'expense', '35.00', '2025-06-08T10:00:00', { bankBalance: '965.00' }),
    ];
    expect(checkSuspectedDuplicates(bills, JUNE_START, JUNE_END)).toHaveLength(1);
  });

  it('只有一腿有余额 → 无法反证，照报', () => {
    const bills = [
      bill('b1', 'a1', 'expense', '35.00', '2025-06-05T10:00:00', { bankBalance: '965.00' }),
      bill('b2', 'a1', 'expense', '35.00', '2025-06-08T10:00:00'),
    ];
    expect(checkSuspectedDuplicates(bills, JUNE_START, JUNE_END)).toHaveLength(1);
  });

  it('余额差 ≤ 0.01 视为相同，照报', () => {
    const bills = [
      bill('b1', 'a1', 'expense', '35.00', '2025-06-05T10:00:00', { bankBalance: '965.000' }),
      bill('b2', 'a1', 'expense', '35.00', '2025-06-08T10:00:00', { bankBalance: '965.009' }),
    ];
    expect(checkSuspectedDuplicates(bills, JUNE_START, JUNE_END)).toHaveLength(1);
  });

  it('两腿外部单号不同 → 铁定两笔真实交易（地铁日扣场景），不报', () => {
    const bills = [
      bill('b1', 'a1', 'expense', '5.40', '2025-06-16T08:00:00', { externalId: 'wx-order-001' }),
      bill('b2', 'a1', 'expense', '5.40', '2025-06-16T18:00:00', { externalId: 'wx-order-002' }),
      bill('b3', 'a1', 'expense', '5.40', '2025-06-17T08:00:00', { externalId: 'wx-order-003' }),
    ];
    expect(checkSuspectedDuplicates(bills, JUNE_START, JUNE_END)).toHaveLength(0);
  });

  it('只有一腿有单号 → 无法反证，照报', () => {
    const bills = [
      bill('b1', 'a1', 'expense', '35.00', '2025-06-05T10:00:00', { externalId: 'wx-order-001' }),
      bill('b2', 'a1', 'expense', '35.00', '2025-06-06T10:00:00'),
    ];
    expect(checkSuspectedDuplicates(bills, JUNE_START, JUNE_END)).toHaveLength(1);
  });
});

describe('fuzzyCategoryMatch', () => {
  const parentOf = new Map<string, string | null>([
    ['food', null],
    ['food_snack', 'food'],
    ['food_drink', 'food'],
    ['trans', null],
  ]);
  it('同分类 / 父子 / 兄弟命中；无关不命中', () => {
    expect(fuzzyCategoryMatch('food', 'food', parentOf)).toBe(true);
    expect(fuzzyCategoryMatch('food_snack', 'food', parentOf)).toBe(true);
    expect(fuzzyCategoryMatch('food', 'food_snack', parentOf)).toBe(true);
    expect(fuzzyCategoryMatch('food_snack', 'food_drink', parentOf)).toBe(true);
    expect(fuzzyCategoryMatch('food', 'trans', parentOf)).toBe(false);
  });
});

describe('checkRecurringMissing', () => {
  const parentOf = new Map<string, string | null>([
    ['rent', null],
    ['rent_house', 'rent'],
  ]);
  const rec = (
    id: string,
    nextDate: string,
    extra: Partial<RcRecurring> = {},
  ): RcRecurring => ({
    id,
    accountId: 'a1',
    categoryId: 'rent',
    type: 'expense',
    amount: '3000.00',
    nextDate: D(nextDate),
    ...extra,
  });
  const asOf = JUNE_END; // 查历史月份：asOf = 月末

  it('nextDate 已过且当月无匹配 → 缺记', () => {
    const out = checkRecurringMissing(
      [rec('r1', '2025-06-05T09:00:00')],
      [],
      parentOf,
      JUNE_START, JUNE_END, asOf,
    );
    expect(out).toHaveLength(1);
    expect(out[0].recurringId).toBe('r1');
    expect(out[0].severity).toBe('info');
  });

  it('当月有同金额同分类账单 → 不报', () => {
    const bills = [
      bill('b1', 'a1', 'expense', '3000.00', '2025-06-05T12:00:00', { categoryId: 'rent' }),
    ];
    expect(
      checkRecurringMissing([rec('r1', '2025-06-05T09:00:00')], bills, parentOf, JUNE_START, JUNE_END, asOf),
    ).toHaveLength(0);
  });

  it('模糊匹配：子分类账单也能核销父分类周期项', () => {
    const bills = [
      bill('b1', 'a1', 'expense', '3000.00', '2025-06-06T12:00:00', { categoryId: 'rent_house' }),
    ];
    expect(
      checkRecurringMissing([rec('r1', '2025-06-05T09:00:00')], bills, parentOf, JUNE_START, JUNE_END, asOf),
    ).toHaveLength(0);
  });

  it('金额差 > 0.01 或方向不符 → 仍算缺记', () => {
    const bills = [
      bill('b1', 'a1', 'expense', '3000.02', '2025-06-05T12:00:00'),
      bill('b2', 'a1', 'income', '3000.00', '2025-06-05T12:00:00'),
    ];
    expect(
      checkRecurringMissing([rec('r1', '2025-06-05T09:00:00')], bills, parentOf, JUNE_START, JUNE_END, asOf),
    ).toHaveLength(1);
  });

  it('nextDate 未到（> asOf）不报；查当月时 asOf = 今天', () => {
    const midJune = new Date(2025, 5, 15, 12, 0, 0);
    const out = checkRecurringMissing(
      [rec('r1', '2025-06-20T09:00:00')],
      [],
      parentOf,
      JUNE_START, JUNE_END, midJune,
    );
    expect(out).toHaveLength(0);
  });

  it('上月账单不能核销本月', () => {
    const bills = [bill('b1', 'a1', 'expense', '3000.00', '2025-05-31T12:00:00')];
    expect(
      checkRecurringMissing([rec('r1', '2025-06-05T09:00:00')], bills, parentOf, JUNE_START, JUNE_END, asOf),
    ).toHaveLength(1);
  });
});

describe('checkTransferOrphans', () => {
  it('同金额反方向 ±2 天不同账户 → 配对成功，无孤儿', () => {
    const bills = [
      bill('t1', 'a1', 'expense', '500.00', '2025-06-10T10:00:00', { isTransfer: true }),
      bill('t2', 'a2', 'income', '500.00', '2025-06-11T10:00:00', { isTransfer: true }),
    ];
    expect(checkTransferOrphans(bills, JUNE_START, JUNE_END)).toHaveLength(0);
  });

  it('缺另一腿 → 报孤儿（只报落在当月的腿）', () => {
    const bills = [
      bill('t1', 'a1', 'expense', '500.00', '2025-06-10T10:00:00', { isTransfer: true }),
      bill('t0', 'a2', 'income', '300.00', '2025-05-29T10:00:00', { isTransfer: true }),
    ];
    const out = checkTransferOrphans(bills, JUNE_START, JUNE_END);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('t1');
  });

  it('同账户 / 金额不等 / 差 3 天 → 均配不上', () => {
    const mk = (id: string, accId: string, type: string, amount: string, date: string) =>
      bill(id, accId, type, amount, date, { isTransfer: true });
    const sameAcc = [
      mk('t1', 'a1', 'expense', '500.00', '2025-06-10T10:00:00'),
      mk('t2', 'a1', 'income', '500.00', '2025-06-10T11:00:00'),
    ];
    expect(checkTransferOrphans(sameAcc, JUNE_START, JUNE_END)).toHaveLength(2);

    const diffAmt = [
      mk('t1', 'a1', 'expense', '500.00', '2025-06-10T10:00:00'),
      mk('t2', 'a2', 'income', '500.01', '2025-06-10T11:00:00'),
    ];
    expect(checkTransferOrphans(diffAmt, JUNE_START, JUNE_END)).toHaveLength(2);

    const far = [
      mk('t1', 'a1', 'expense', '500.00', '2025-06-10T10:00:00'),
      mk('t2', 'a2', 'income', '500.00', '2025-06-13T10:00:01'),
    ];
    expect(checkTransferOrphans(far, JUNE_START, JUNE_END)).toHaveLength(2);
  });

  it('2 支出 + 1 收入同金额：贪心配对后恰剩 1 个孤儿', () => {
    const bills = [
      bill('t1', 'a1', 'expense', '200.00', '2025-06-05T10:00:00', { isTransfer: true }),
      bill('t2', 'a1', 'expense', '200.00', '2025-06-06T10:00:00', { isTransfer: true }),
      bill('t3', 'a2', 'income', '200.00', '2025-06-06T12:00:00', { isTransfer: true }),
    ];
    const out = checkTransferOrphans(bills, JUNE_START, JUNE_END);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('expense');
  });

  it('非转账账单不参与配对', () => {
    const bills = [
      bill('n1', 'a2', 'income', '500.00', '2025-06-10T10:00:00'),
      bill('t1', 'a1', 'expense', '500.00', '2025-06-10T10:00:00', { isTransfer: true }),
    ];
    const out = checkTransferOrphans(bills, JUNE_START, JUNE_END);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('t1');
  });
});

describe('worstSeverity', () => {
  it('空 = ok；取最高档', () => {
    expect(worstSeverity([])).toBe('ok');
    expect(
      worstSeverity([
        { severity: 'info' },
        { severity: 'critical' },
        { severity: 'warning' },
      ]),
    ).toBe('critical');
  });
});

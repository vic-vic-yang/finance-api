import { Prisma } from '@prisma/client';
import {
  monthEndNetWorth,
  monthlyPatternForecast,
  detectRecurringIncome,
  recurringNetBetween,
  expensePace,
  goalEtaDate,
  IncomeBillLike,
} from './forecast.calc';

const d = (v: number | string) => new Prisma.Decimal(v);
const ib = (amount: number, dayOfMonth: number, categoryId = 'salary'): IncomeBillLike => ({
  amount: d(amount),
  dayOfMonth,
  categoryId,
});

describe('detectRecurringIncome', () => {
  it('同分类同金额连续出现 → 固定收入项；本月未到账则预期', () => {
    const prev = [
      [ib(18000, 10), ib(500, 15, 'bonus')],
      [ib(18000, 11), ib(500, 14, 'bonus')],
      [ib(18000, 10), ib(500, 15, 'bonus')],
    ];
    const out = detectRecurringIncome(prev, []);
    // 工资 18000 + 奖金 500 都未到
    expect(out.expectedRemaining.toNumber()).toBe(18500);
    expect(out.patterns).toHaveLength(2);
  });

  it('本月已到账的固定项不再预期（剩余为 0）', () => {
    const prev = [
      [ib(18000, 10)],
      [ib(18000, 11)],
      [ib(18000, 10)],
    ];
    const out = detectRecurringIncome(prev, [ib(18000, 12)]);
    expect(out.expectedRemaining.toNumber()).toBe(0);
    expect(out.patterns[0].fulfilled).toBe(true);
  });

  it('金额在 ±5% 容差内视为同一项', () => {
    const prev = [
      [ib(18000, 10)],
      [ib(18500, 10)],
      [ib(17900, 10)],
    ];
    const out = detectRecurringIncome(prev, [ib(18200, 10)]);
    expect(out.patterns).toHaveLength(1);
    expect(out.expectedRemaining.toNumber()).toBe(0);
  });

  it('只出现 1 个月的收入是一次性的，不预期', () => {
    const prev = [
      [ib(18000, 10), ib(99999, 20, 'windfall')],
      [ib(18000, 10)],
      [ib(18000, 10)],
    ];
    const out = detectRecurringIncome(prev, [ib(18000, 10)]);
    // 只有工资是固定项且已到账；意外之财不预期
    expect(out.patterns).toHaveLength(1);
    expect(out.expectedRemaining.toNumber()).toBe(0);
  });

  it('不同分类即使金额相同也不归为同一项', () => {
    const prev = [
      [ib(5000, 10, 'a')],
      [ib(5000, 10, 'b')],
      [ib(5000, 10, 'a')],
    ];
    const out = detectRecurringIncome(prev, []);
    // 分类 a 出现 2 个月 → 固定项；分类 b 只 1 个月 → 一次性
    expect(out.patterns).toHaveLength(1);
    expect(out.expectedRemaining.toNumber()).toBe(5000);
  });

  it('空历史 → 无固定项，预期为 0', () => {
    const out = detectRecurringIncome([[], []], []);
    expect(out.expectedRemaining.toNumber()).toBe(0);
    expect(out.patterns).toHaveLength(0);
  });
});

describe('monthlyPatternForecast', () => {
  it('工资未发：剩余收入 = 月均 − 已收（预期会来）', () => {
    const out = monthlyPatternForecast({
      currentNetWorth: d(10000),
      mtdIncome: d(0),
      mtdExpense: d(1000),
      avgMonthlyIncome: d(6000),
      avgMonthlyExpense: d(3000),
      daysElapsed: 15,
      remainingDays: 15,
    });
    // 剩余收入 6000；
    // 节奏 1000、回归 2000、均匀 1500 → 中位 1500
    expect(out.remainingIncome.toNumber()).toBe(6000);
    expect(out.remainingExpense.toNumber()).toBe(1500);
    expect(out.projected.toNumber()).toBe(14500);
  });

  it('工资已发且超月均：剩余收入为 0，不虚增', () => {
    const out = monthlyPatternForecast({
      currentNetWorth: d(10000),
      mtdIncome: d(8000),
      mtdExpense: d(1000),
      avgMonthlyIncome: d(6000),
      avgMonthlyExpense: d(3000),
      daysElapsed: 15,
      remainingDays: 15,
    });
    expect(out.remainingIncome.toNumber()).toBe(0);
    // 节奏 1000、回归 2000、均匀 1500 → 中位 1500
    expect(out.projected.toNumber()).toBe(8500);
  });

  it('本月花得比历史快：中位数缓和取大偏悲观', () => {
    const out = monthlyPatternForecast({
      currentNetWorth: d(10000),
      mtdIncome: d(6000),
      mtdExpense: d(2500),
      avgMonthlyIncome: d(6000),
      avgMonthlyExpense: d(3000),
      daysElapsed: 10,
      remainingDays: 20,
    });
    // 节奏 5000、回归 500、均匀 2000 → 中位 2000
    expect(out.remainingExpense.toNumber()).toBe(2000);
    expect(out.projected.toNumber()).toBe(8000);
  });

  it('月末最后一天：剩余天数 0 时支出三项皆 0', () => {
    const out = monthlyPatternForecast({
      currentNetWorth: d(10000),
      mtdIncome: d(6000),
      mtdExpense: d(2800),
      avgMonthlyIncome: d(6000),
      avgMonthlyExpense: d(3000),
      daysElapsed: 31,
      remainingDays: 0,
    });
    expect(out.remainingIncome.toNumber()).toBe(0);
    expect(out.remainingExpense.toNumber()).toBe(0);
    expect(out.projected.toNumber()).toBe(10000);
  });

  it('daysElapsed = 0 按 1 天兜底，不除零', () => {
    const out = monthlyPatternForecast({
      currentNetWorth: d(1000),
      mtdIncome: d(0),
      mtdExpense: d(0),
      avgMonthlyIncome: d(0),
      avgMonthlyExpense: d(0),
      daysElapsed: 0,
      remainingDays: 30,
    });
    expect(out.projected.toNumber()).toBe(1000);
  });

  it('显式传入 expectedRemainingIncome=0 时不回退月均', () => {
    const out = monthlyPatternForecast({
      currentNetWorth: d(10000),
      mtdIncome: d(0),
      mtdExpense: d(0),
      avgMonthlyIncome: d(6000),
      avgMonthlyExpense: d(3000),
      daysElapsed: 10,
      remainingDays: 20,
      expectedRemainingIncome: d(0),
    });
    expect(out.remainingIncome.toNumber()).toBe(0);
  });
});

describe('monthEndNetWorth', () => {
  it('当前合计 + 剩余天数×日均净流入 + 剩余周期净额', () => {
    const out = monthEndNetWorth({
      currentNetWorth: d(10000),
      avgDailyNetInflow: d(50),
      remainingDays: 10,
      remainingRecurringNet: d(-300),
    });
    // 10000 + 10×50 − 300 = 10200
    expect(out.toNumber()).toBe(10200);
  });

  it('日均净流入为负时预测低于当前', () => {
    const out = monthEndNetWorth({
      currentNetWorth: d(1000),
      avgDailyNetInflow: d(-100),
      remainingDays: 5,
      remainingRecurringNet: d(0),
    });
    expect(out.toNumber()).toBe(500);
  });

  it('月末最后一天剩余天数为 0，只加周期净额', () => {
    const out = monthEndNetWorth({
      currentNetWorth: d(800),
      avgDailyNetInflow: d(999),
      remainingDays: 0,
      remainingRecurringNet: d(200),
    });
    expect(out.toNumber()).toBe(1000);
  });
});

describe('recurringNetBetween', () => {
  const from = new Date('2026-06-01T00:00:00');
  const to = new Date('2026-06-30T23:59:59');

  it('窗口内收入加、支出减', () => {
    const net = recurringNetBetween(
      [
        { type: 'expense', amount: d(100), nextDate: new Date('2026-06-10') },
        { type: 'income', amount: d(50), nextDate: new Date('2026-06-20') },
      ],
      from,
      to,
    );
    expect(net.toNumber()).toBe(-50);
  });

  it('窗口外不计', () => {
    const net = recurringNetBetween(
      [
        { type: 'expense', amount: d(100), nextDate: new Date('2026-05-31') },
        { type: 'expense', amount: d(100), nextDate: new Date('2026-07-01') },
      ],
      from,
      to,
    );
    expect(net.toNumber()).toBe(0);
  });

  it('边界日期计入（含两端）', () => {
    const net = recurringNetBetween(
      [
        { type: 'expense', amount: d(10), nextDate: from },
        { type: 'income', amount: d(20), nextDate: to },
      ],
      from,
      to,
    );
    expect(net.toNumber()).toBe(10);
  });

  it('空列表为 0', () => {
    expect(recurringNetBetween([], from, to).toNumber()).toBe(0);
  });
});

describe('expensePace', () => {
  it('按「至今支出 / 已过天数 × 当月天数」外推', () => {
    const out = expensePace({
      monthToDateExpense: d(1500),
      daysElapsed: 15,
      daysInMonth: 30,
      monthlyBudget: null,
    });
    expect(out.projectedMonthExpense.toNumber()).toBe(3000);
    expect(out.overspendRisk).toBe(false);
  });

  it('外推超预算 → overspendRisk = true', () => {
    const out = expensePace({
      monthToDateExpense: d(3200),
      daysElapsed: 15,
      daysInMonth: 30,
      monthlyBudget: d(6000),
    });
    expect(out.projectedMonthExpense.toNumber()).toBe(6400);
    expect(out.overspendRisk).toBe(true);
  });

  it('无预算 / 预算为 0 → 无超支风险', () => {
    expect(
      expensePace({
        monthToDateExpense: d(99999),
        daysElapsed: 1,
        daysInMonth: 30,
        monthlyBudget: null,
      }).overspendRisk,
    ).toBe(false);
    expect(
      expensePace({
        monthToDateExpense: d(99999),
        daysElapsed: 1,
        daysInMonth: 30,
        monthlyBudget: d(0),
      }).overspendRisk,
    ).toBe(false);
  });

  it('daysElapsed = 0 按 1 天兜底，不除零', () => {
    const out = expensePace({
      monthToDateExpense: d(0),
      daysElapsed: 0,
      daysInMonth: 30,
      monthlyBudget: d(1),
    });
    expect(out.projectedMonthExpense.toNumber()).toBe(0);
    expect(out.overspendRisk).toBe(false);
  });
});

describe('goalEtaDate', () => {
  const now = new Date('2026-06-15T12:00:00');

  it('已达成（remaining ≤ 0）→ 返回 now', () => {
    expect(
      goalEtaDate({ remaining: d(0), monthlyRate: d(100), now })?.getTime(),
    ).toBe(now.getTime());
    expect(
      goalEtaDate({ remaining: d(-5), monthlyRate: d(100), now })?.getTime(),
    ).toBe(now.getTime());
  });

  it('月均净存入 ≤ 0 → null（无法估算）', () => {
    expect(goalEtaDate({ remaining: d(100), monthlyRate: d(0), now })).toBeNull();
    expect(
      goalEtaDate({ remaining: d(100), monthlyRate: d(-1), now }),
    ).toBeNull();
  });

  it('remaining=3000 rate=1500 → 2 个月 ≈ 61 天后', () => {
    const eta = goalEtaDate({ remaining: d(3000), monthlyRate: d(1500), now })!;
    const days = Math.round((eta.getTime() - now.getTime()) / 86_400_000);
    expect(days).toBe(Math.ceil(2 * 30.44)); // 61
  });

  it('不足一个月按天向上进位', () => {
    const eta = goalEtaDate({ remaining: d(100), monthlyRate: d(3000), now })!;
    const days = Math.round((eta.getTime() - now.getTime()) / 86_400_000);
    expect(days).toBe(Math.ceil((100 / 3000) * 30.44)); // 2
  });
});

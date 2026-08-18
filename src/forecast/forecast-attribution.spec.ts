import { Prisma } from '@prisma/client';
import { buildForecastAttribution } from './forecast.calc';

const D = (n: number | string) => new Prisma.Decimal(n);

describe('buildForecastAttribution', () => {
  it('monthly 模式：当前 + 收入 − 支出 == 预测值', () => {
    const items = buildForecastAttribution({
      method: 'monthly',
      currentNetWorth: D(1000),
      remainingIncome: D(300),
      remainingExpense: D(200),
      dailyNetInflow: D(0),
      remainingRecurringNet: D(50),
    });
    expect(items.map((i) => i.key)).toEqual(['current', 'income', 'expense']);
    const sum = items.reduce((s, i) => s.plus(i.amount), D(0));
    expect(sum.toNumber()).toBe(1100); // 1000 + 300 - 200
  });

  it('daily 模式：当前 + 日均外推 + 周期净额 == 预测值', () => {
    const items = buildForecastAttribution({
      method: 'daily',
      currentNetWorth: D(1000),
      remainingIncome: D(0),
      remainingExpense: D(0),
      dailyNetInflow: D(-80),
      remainingRecurringNet: D(-120),
    });
    expect(items.map((i) => i.key)).toEqual(['current', 'daily', 'recurring']);
    const sum = items.reduce((s, i) => s.plus(i.amount), D(0));
    expect(sum.toNumber()).toBe(800); // 1000 - 80 - 120
  });

  it('支出项符号为负', () => {
    const items = buildForecastAttribution({
      method: 'monthly',
      currentNetWorth: D(100),
      remainingIncome: D(0),
      remainingExpense: D(40),
      dailyNetInflow: D(0),
      remainingRecurringNet: D(0),
    });
    expect(items.find((i) => i.key === 'expense')!.amount.toNumber()).toBe(-40);
  });
});

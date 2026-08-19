import { Prisma } from '@prisma/client';
import { resolveRecurringNextDate } from './recurring-match';

const amount = (value: number) => new Prisma.Decimal(value);

describe('resolveRecurringNextDate', () => {
  const recurring = {
    type: 'expense' as const,
    amount: amount(4029.04),
    accountId: 'provident-fund',
    categoryId: 'mortgage',
    cycleType: 'monthly',
    cycleDay: 5,
    nextDate: new Date('2026-08-05T09:00:00+08:00'),
  };

  it('本月已有对应还款时推进到下个月，不再显示逾期', () => {
    const result = resolveRecurringNextDate(
      recurring,
      [
        {
          type: 'expense' as const,
          amount: amount(4029.04),
          accountId: 'provident-fund',
          categoryId: 'mortgage',
          date: new Date('2026-08-05T12:00:00+08:00'),
        },
      ],
      new Date('2026-08-19T21:11:00+08:00'),
    );

    expect(result.toISOString()).toBe('2026-09-05T01:00:00.000Z');
  });

  it('账户不同的同金额支出不能冒充本期还款', () => {
    const result = resolveRecurringNextDate(
      recurring,
      [
        {
          type: 'expense' as const,
          amount: amount(4029.04),
          accountId: 'other-account',
          categoryId: 'mortgage',
          date: new Date('2026-08-05T12:00:00+08:00'),
        },
      ],
      new Date('2026-08-19T21:11:00+08:00'),
    );

    expect(result.getTime()).toBe(recurring.nextDate.getTime());
  });

  it('到期日前后七天内的提前或延后还款都算本期已还', () => {
    const result = resolveRecurringNextDate(
      recurring,
      [
        {
          type: 'expense' as const,
          amount: amount(4029.04),
          accountId: 'provident-fund',
          categoryId: 'mortgage',
          date: new Date('2026-08-11T12:00:00+08:00'),
        },
      ],
      new Date('2026-08-19T21:11:00+08:00'),
    );

    expect(result.getMonth()).toBe(8);
    expect(result.getDate()).toBe(5);
  });
});

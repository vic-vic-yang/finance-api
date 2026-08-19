import { Prisma } from '@prisma/client';

export interface RecurringMatchLike {
  type: 'income' | 'expense';
  amount: Prisma.Decimal;
  accountId: string;
  categoryId: string;
  cycleType: string;
  cycleDay: number;
  nextDate: Date;
}

export interface BillMatchLike {
  type: 'income' | 'expense';
  amount: Prisma.Decimal;
  accountId: string;
  categoryId: string;
  date: Date;
}

const DAY_MS = 86_400_000;

function advanceDate(cycleType: string, cycleDay: number, from: Date): Date {
  if (cycleType === 'weekly') {
    const next = new Date(from);
    next.setDate(next.getDate() + 7);
    return next;
  }
  if (cycleType === 'yearly') {
    const next = new Date(from);
    next.setFullYear(next.getFullYear() + 1);
    return next;
  }

  const nextMonth = new Date(
    from.getFullYear(),
    from.getMonth() + 1,
    1,
    from.getHours(),
    from.getMinutes(),
    from.getSeconds(),
    from.getMilliseconds(),
  );
  const lastDay = new Date(
    nextMonth.getFullYear(),
    nextMonth.getMonth() + 1,
    0,
  ).getDate();
  nextMonth.setDate(Math.min(cycleDay, lastDay));
  return nextMonth;
}

export function resolveRecurringNextDate(
  recurring: RecurringMatchLike,
  bills: BillMatchLike[],
  now: Date,
): Date {
  let nextDate = new Date(recurring.nextDate);
  const unusedBills = [...bills];

  while (nextDate.getTime() <= now.getTime()) {
    const matchedIndex = unusedBills.findIndex((bill) => {
      if (
        bill.type !== recurring.type ||
        bill.accountId !== recurring.accountId ||
        bill.categoryId !== recurring.categoryId
      ) {
        return false;
      }
      const amountTolerance = Prisma.Decimal.max(
        recurring.amount.abs().mul(0.01),
        1,
      );
      if (bill.amount.minus(recurring.amount).abs().gt(amountTolerance)) {
        return false;
      }
      return Math.abs(bill.date.getTime() - nextDate.getTime()) <= 7 * DAY_MS;
    });

    if (matchedIndex < 0) break;
    unusedBills.splice(matchedIndex, 1);
    nextDate = advanceDate(recurring.cycleType, recurring.cycleDay, nextDate);
  }

  return nextDate;
}

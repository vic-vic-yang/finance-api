import { BillsService } from './bills.service';
import { Prisma } from '@prisma/client';

describe('BillsService grouped queries', () => {
  function setup(rows: any[] = []) {
    const db = {
      $queryRaw: jest.fn().mockResolvedValue(rows),
      bill: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        aggregate: jest.fn().mockResolvedValue({_sum: {amount: new Prisma.Decimal(0)}}),
      },
      category: {findMany: jest.fn().mockResolvedValue([{id: 'child'}])},
    };
    return {db, service: new BillsService(db as any)};
  }

  it('returns 12 complete groups and a cursor without fetching bill records', async () => {
    const rows = Array.from({length: 13}, (_, i) => ({
      key: `2026-09-${String(30-i).padStart(2, '0')}`, count: 50,
      income: new Prisma.Decimal('10.20'), expense: new Prisma.Decimal('3.10'),
    }));
    const {db, service} = setup(rows);
    const res = await service.findAll('ledger', {groupBy: 'day'});
    expect(res.groups).toHaveLength(12);
    expect(res.nextGroup).toBe('2026-09-19');
    expect(res.groups[0].balance).toBe(7.1);
    expect(db.bill.findMany).not.toHaveBeenCalled();
  });

  it('keeps date-only filters and detail boundaries in the same UTC+8 interval', async () => {
    const {db, service} = setup();
    await service.findAll('ledger', {groupBy: 'month', startDate: '2026-09-01',
      endDate: '2026-09-30', timezoneOffset: 480,
      startAt: '2026-08-31T16:00:00.000Z', endBefore: '2026-09-30T16:00:00.000Z'});
    const scope = db.bill.aggregate.mock.calls[0][0].where.AND[0];
    expect(scope.date).toEqual({gte: new Date('2026-08-31T16:00:00Z'), lt: new Date('2026-09-30T16:00:00Z')});
    expect(scope.AND[0].date).toEqual(scope.date);
  });

  it('shares member/account/category/amount/type filters with full totals', async () => {
    const {db, service} = setup();
    await service.findAll('ledger', {groupBy: 'month', type: 'expense', categoryIds: 'parent',
      accountIds: 'account', userIds: 'user', minAmount: 1, maxAmount: 100});
    const scope = db.bill.aggregate.mock.calls[0][0].where.AND[0];
    expect(scope).toMatchObject({ledgerId: 'ledger', type: 'expense', isTransfer: false,
      accountId: 'account', userId: 'user', categoryId: {in: ['parent', 'child']},
      amount: {gte: 1, lte: 100}, source: {not: 'stock'}});
    const raw = db.$queryRaw.mock.calls[0][0] as Prisma.Sql;
    expect(raw.text).toContain('"type"::text');
    expect(raw.values).toEqual(expect.arrayContaining(['ledger', 'expense', 'parent', 'child', 'account', 'user', 1, 100]));
  });
});

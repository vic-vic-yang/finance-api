import { Prisma } from '@prisma/client';
import { AccountsService } from './accounts.service';

describe('AccountsService automatic deposits', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date(2026, 7, 6, 12));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('creates one bill and one balance increment when account reads race', async () => {
    const account = {
      id: 'account-1',
      ledgerId: 'ledger-1',
      ownerId: 'user-1',
      nameCipher: Buffer.from('name'),
      nameDekVer: 1,
      type: 'INSURANCE',
      balance: new Prisma.Decimal('100'),
      initialBalance: new Prisma.Decimal('100'),
      icon: null,
      color: null,
      statementDay: null,
      dueDay: null,
      creditLimit: null,
      interestRate: null,
      loanPrincipal: null,
      loanTermMonths: null,
      firstPaymentDate: null,
      repaymentMethod: null,
      autoDepositDay: 5,
      autoDepositAmount: new Prisma.Decimal('87.17'),
      autoDepositCategoryId: 'category-1',
      lastAutoProcessedAt: new Date(2026, 6, 5),
      createdAt: new Date(2026, 0, 1),
      updatedAt: new Date(2026, 6, 5),
      owner: { id: 'user-1', username: 'owner', nickname: null },
    };
    const createdBills: Array<Record<string, unknown>> = [];
    const seenKeys = new Set<string>();
    let balanceIncrements = 0;
    const tx = {
      bill: {
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          const period = data.autoDepositPeriod as Date | undefined;
          const key = period
            ? `${data.accountId as string}:${period.toISOString()}`
            : undefined;
          if (key && seenKeys.has(key)) {
            throw new Prisma.PrismaClientKnownRequestError(
              'Unique constraint failed',
              {
                code: 'P2002',
                clientVersion: 'test',
                meta: { target: ['accountId', 'autoDepositPeriod'] },
              },
            );
          }
          if (key) seenKeys.add(key);
          createdBills.push(data);
          return data;
        }),
      },
      account: {
        update: jest.fn(async () => {
          balanceIncrements += 1;
          return account;
        }),
        updateMany: jest.fn(async () => ({ count: 1 })),
      },
    };
    const prisma = {
      account: {
        findMany: jest.fn(async () => [account]),
        updateMany: tx.account.updateMany,
      },
      category: {
        findFirst: jest.fn(async () => ({ id: 'category-1' })),
      },
      ledger: {
        findUnique: jest.fn(async () => ({ ownerId: 'user-1' })),
      },
      $transaction: jest.fn(async (operation: unknown) => {
        if (typeof operation === 'function') {
          return (operation as (client: typeof tx) => Promise<unknown>)(tx);
        }
        return Promise.all(operation as Promise<unknown>[]);
      }),
      bill: tx.bill,
    };
    const service = new AccountsService(prisma as never);

    await Promise.all([
      service.findAll('ledger-1', 'user-1'),
      service.findAll('ledger-1', 'user-1'),
    ]);

    expect(createdBills).toHaveLength(1);
    expect(balanceIncrements).toBe(1);
    expect(prisma.account.updateMany).toHaveBeenCalledTimes(1);
    expect(createdBills[0]).toMatchObject({
      accountId: 'account-1',
      amount: new Prisma.Decimal('87.17'),
      date: new Date(2026, 7, 5),
      autoDepositPeriod: new Date(2026, 7, 5),
    });
  });
});

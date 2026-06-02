import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateBillDto } from './dto/create-bill.dto';
import { UpdateBillDto } from './dto/update-bill.dto';
import { QueryBillDto } from './dto/query-bill.dto';

const BILL_INCLUDE = {
  category: { select: { id: true, name: true, icon: true, color: true } },
  account: {
    select: { id: true, nameCipher: true, nameDekVer: true, type: true },
  },
  user: { select: { id: true, username: true, nickname: true } },
};

function shapeBillUser(u: {
  id: string;
  username: string;
  nickname?: string | null;
} | null | undefined) {
  if (!u) return null;
  const nick = (u.nickname ?? '').trim();
  return {
    id: u.id,
    username: u.username,
    nickname: u.nickname ?? null,
    displayName: nick.length > 0 ? nick : u.username,
  };
}

@Injectable()
export class BillsService {
  constructor(private prisma: PrismaService) {}

  async findAll(ledgerId: string, query: QueryBillDto) {
    const {
      page = 1, limit = 20, type, categoryId, accountId, userId, startDate, endDate,
    } = query;
    const skip = (page - 1) * Number(limit);

    const where: Prisma.BillWhereInput = { ledgerId };
    if (type) where.type = type;
    if (categoryId) where.categoryId = categoryId;
    if (accountId) where.accountId = accountId;
    if (userId) where.userId = userId;
    if (startDate || endDate) {
      where.date = {};
      if (startDate) (where.date as any).gte = new Date(startDate);
      if (endDate) (where.date as any).lte = new Date(`${endDate}T23:59:59.999`);
    }

    const [bills, total, incomeAgg, expenseAgg] = await Promise.all([
      this.prisma.bill.findMany({
        where, include: BILL_INCLUDE,
        orderBy: { date: 'desc' }, skip, take: Number(limit),
      }),
      this.prisma.bill.count({ where }),
      this.prisma.bill.aggregate({
        // 转账账单不计入收支汇总（但仍出现在上面的账单列表里）
        where: { ...where, type: 'income', isTransfer: false }, _sum: { amount: true },
      }),
      this.prisma.bill.aggregate({
        where: { ...where, type: 'expense', isTransfer: false }, _sum: { amount: true },
      }),
    ]);

    return {
      bills: bills.map((b) => this.serialize(b)),
      pagination: {
        page: Number(page), limit: Number(limit), total,
        totalPages: Math.ceil(total / Number(limit)),
      },
      summary: {
        totalIncome: Number(incomeAgg._sum.amount || 0),
        totalExpense: Number(expenseAgg._sum.amount || 0),
      },
    };
  }

  async findOne(ledgerId: string, id: string) {
    const bill = await this.prisma.bill.findFirst({
      where: { id, ledgerId }, include: BILL_INCLUDE,
    });
    if (!bill) throw new NotFoundException('账单不存在');
    return { bill: this.serialize(bill) };
  }

  async create(ledgerId: string, userId: string, dto: CreateBillDto) {
    return this.prisma.$transaction(async (tx) => {
      const account = await tx.account.findFirst({
        where: {
          id: dto.accountId,
          ledgerId,
          OR: [{ ownerId: null }, { ownerId: userId }],
        },
      });
      if (!account) throw new NotFoundException('账户不存在或无权使用');

      const category = await tx.category.findFirst({
        where: {
          id: dto.categoryId,
          OR: [{ ledgerId }, { isSystem: true }],
        },
      });
      if (!category) throw new NotFoundException('分类不存在');

      const amount = new Prisma.Decimal(dto.amount);
      const noteCipher = Buffer.from(dto.noteCipher, 'base64');
      const bill = await tx.bill.create({
        data: {
          ledgerId,
          userId,
          accountId: dto.accountId,
          categoryId: dto.categoryId,
          type: dto.type as any,
          amount,
          noteCipher,
          noteDekVer: dto.noteDekVer,
          date: dto.date ? new Date(dto.date) : new Date(),
        },
        include: BILL_INCLUDE,
      });

      if (dto.type === 'income') {
        await tx.account.update({
          where: { id: dto.accountId },
          data: { balance: { increment: dto.amount } },
        });
      } else {
        await tx.account.update({
          where: { id: dto.accountId },
          data: { balance: { decrement: dto.amount } },
        });
      }
      return { message: '添加成功', bill: this.serialize(bill) };
    });
  }

  async update(ledgerId: string, userId: string, id: string, dto: UpdateBillDto) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.bill.findFirst({ where: { id, ledgerId } });
      if (!existing) throw new NotFoundException('账单不存在');

      if (dto.accountId && dto.accountId !== existing.accountId) {
        const newAcc = await tx.account.findFirst({
          where: {
            id: dto.accountId,
            ledgerId,
            OR: [{ ownerId: null }, { ownerId: userId }],
          },
        });
        if (!newAcc) throw new NotFoundException('账户不存在或无权使用');
      }

      const oldAmount = Number(existing.amount);
      if (existing.type === 'income') {
        await tx.account.update({
          where: { id: existing.accountId },
          data: { balance: { decrement: oldAmount } },
        });
      } else {
        await tx.account.update({
          where: { id: existing.accountId },
          data: { balance: { increment: oldAmount } },
        });
      }

      const newType = dto.type || existing.type;
      const newAmount = dto.amount ?? oldAmount;
      const newAccountId = dto.accountId || existing.accountId;

      const bill = await tx.bill.update({
        where: { id },
        data: {
          ...(dto.type && { type: dto.type as any }),
          ...(dto.amount !== undefined && {
            amount: new Prisma.Decimal(dto.amount),
          }),
          ...(dto.categoryId && { categoryId: dto.categoryId }),
          ...(dto.accountId && { accountId: dto.accountId }),
          ...(dto.noteCipher !== undefined && {
            noteCipher: Buffer.from(dto.noteCipher, 'base64'),
            noteDekVer: dto.noteDekVer ?? existing.noteDekVer,
          }),
          ...(dto.date && { date: new Date(dto.date) }),
        },
        include: BILL_INCLUDE,
      });

      if (newType === 'income') {
        await tx.account.update({
          where: { id: newAccountId },
          data: { balance: { increment: newAmount } },
        });
      } else {
        await tx.account.update({
          where: { id: newAccountId },
          data: { balance: { decrement: newAmount } },
        });
      }
      return { message: '更新成功', bill: this.serialize(bill) };
    });
  }

  async remove(ledgerId: string, id: string) {
    return this.prisma.$transaction(async (tx) => {
      const bill = await tx.bill.findFirst({ where: { id, ledgerId } });
      if (!bill) throw new NotFoundException('账单不存在');

      await tx.bill.delete({ where: { id } });

      const amount = Number(bill.amount);
      if (bill.type === 'income') {
        await tx.account.update({
          where: { id: bill.accountId },
          data: { balance: { decrement: amount } },
        });
      } else {
        await tx.account.update({
          where: { id: bill.accountId },
          data: { balance: { increment: amount } },
        });
      }
      return { message: '删除成功' };
    });
  }

  private serialize(bill: any) {
    return {
      ...bill,
      amount: Number(bill.amount),
      // 密文走 base64（HTTP/JSON 不直接传 BYTEA）
      noteCipher: bill.noteCipher
        ? Buffer.from(bill.noteCipher).toString('base64')
        : null,
      account: bill.account
        ? {
            id: bill.account.id,
            type: bill.account.type,
            nameCipher: bill.account.nameCipher
              ? Buffer.from(bill.account.nameCipher).toString('base64')
              : null,
            nameDekVer: bill.account.nameDekVer,
          }
        : null,
      user: shapeBillUser(bill.user),
    };
  }
}

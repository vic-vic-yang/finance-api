import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateLoanDto, RepayLoanDto } from './loans.dto';

/**
 * 借贷往来：借出(lend/应收) 或 借入(borrow/应付)。
 * 本金的进出走「转账类」账单(isTransfer=true)，不计收支；对方信息只在备注(密文)里。
 */
@Injectable()
export class LoansService {
  constructor(private prisma: PrismaService) {}

  private ser(l: any) {
    const amount = Number(l.amount);
    const repaid = Number(l.repaidAmount);
    return {
      id: l.id,
      direction: l.direction,
      amount,
      repaidAmount: repaid,
      outstanding: Math.max(0, amount - repaid),
      accountId: l.accountId,
      noteCipher: l.noteCipher,
      noteDekVer: l.noteDekVer,
      voucherKey: l.voucherKey,
      date: l.date.toISOString(),
      settled: l.settledAt != null,
      settledAt: l.settledAt ? l.settledAt.toISOString() : null,
      createdAt: l.createdAt.toISOString(),
    };
  }

  /** 列表：该账本所有借贷，按创建倒序（新建在前） */
  async list(ledgerId: string) {
    const rows = await this.prisma.loan.findMany({
      where: { ledgerId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((l) => this.ser(l));
  }

  /** 汇总：总应收(别人欠我) / 总应付(我欠别人) —— 仅未结清部分 */
  async summary(ledgerId: string) {
    const rows = await this.prisma.loan.findMany({
      where: { ledgerId, settledAt: null },
      select: { direction: true, amount: true, repaidAmount: true },
    });
    let receivable = 0;
    let payable = 0;
    for (const l of rows) {
      const out = Math.max(0, Number(l.amount) - Number(l.repaidAmount));
      if (l.direction === 'lend') receivable += out;
      else payable += out;
    }
    return { receivable, payable };
  }

  /** 新建借出/借入：调整出入款账户余额 + 转账类账单，并建借贷记录 */
  async create(ledgerId: string, userId: string, dto: CreateLoanDto) {
    return this.prisma.$transaction(async (tx) => {
      const amount = new Prisma.Decimal(dto.amount);
      const isLend = dto.direction === 'lend';

      if (dto.accountId) {
        const acc = await tx.account.findFirst({
          where: { id: dto.accountId, ledgerId },
        });
        if (!acc) throw new NotFoundException('账户不存在');
        if (acc.ownerId !== null && acc.ownerId !== userId) {
          throw new ForbiddenException('无权操作他人的私人账户');
        }
        const categoryId = await this.getOrCreateLoanCategory(tx, ledgerId);
        // 借出=钱出去(expense)；借入=钱进来(income)。均 isTransfer，不计收支。
        await tx.bill.create({
          data: {
            ledgerId,
            userId,
            accountId: acc.id,
            categoryId,
            type: isLend ? 'expense' : 'income',
            amount,
            noteCipher: Buffer.from(dto.noteCipher ?? '', 'base64'),
            noteDekVer: dto.noteDekVer ?? 1,
            date: dto.date ? new Date(dto.date) : new Date(),
            source: 'loan',
            isTransfer: true,
          },
        });
        await tx.account.update({
          where: { id: acc.id },
          data: { balance: isLend ? { decrement: amount } : { increment: amount } },
        });
      }

      const loan = await tx.loan.create({
        data: {
          ledgerId,
          userId,
          direction: dto.direction,
          amount,
          accountId: dto.accountId ?? null,
          noteCipher: dto.noteCipher ?? null,
          noteDekVer: dto.noteDekVer ?? 1,
          voucherKey: dto.voucherKey ?? null,
          date: dto.date ? new Date(dto.date) : new Date(),
        },
      });
      return this.ser(loan);
    });
  }

  /** 记还款/收款：调整账户余额 + 转账类账单，更新已还，还清则结清 */
  async repay(ledgerId: string, userId: string, id: string, dto: RepayLoanDto) {
    return this.prisma.$transaction(async (tx) => {
      const loan = await tx.loan.findFirst({ where: { id, ledgerId } });
      if (!loan) throw new NotFoundException('借贷记录不存在');
      const amount = new Prisma.Decimal(dto.amount);
      const isLend = loan.direction === 'lend';
      const accId = dto.accountId ?? loan.accountId;

      if (accId) {
        const acc = await tx.account.findFirst({
          where: { id: accId, ledgerId },
        });
        if (acc) {
          if (acc.ownerId !== null && acc.ownerId !== userId) {
            throw new ForbiddenException('无权操作他人的私人账户');
          }
          const categoryId = await this.getOrCreateLoanCategory(tx, ledgerId);
          // 借出的还款=钱收回(income)；借入的还款=钱还出去(expense)。
          await tx.bill.create({
            data: {
              ledgerId,
              userId,
              accountId: acc.id,
              categoryId,
              type: isLend ? 'income' : 'expense',
              amount,
              noteCipher: Buffer.from(dto.noteCipher ?? '', 'base64'),
              noteDekVer: dto.noteDekVer ?? 1,
              date: new Date(),
              source: 'loan',
              isTransfer: true,
            },
          });
          await tx.account.update({
            where: { id: acc.id },
            data: {
              balance: isLend ? { increment: amount } : { decrement: amount },
            },
          });
        }
      }

      const newRepaid = loan.repaidAmount.plus(amount);
      const settled = newRepaid.gte(loan.amount);
      const updated = await tx.loan.update({
        where: { id },
        data: {
          repaidAmount: newRepaid,
          settledAt: settled ? new Date() : null,
        },
      });
      return this.ser(updated);
    });
  }

  /** 删除借贷记录（仅删记录，不回滚已生成的账单/余额——历史轨迹保留） */
  async remove(ledgerId: string, id: string) {
    const loan = await this.prisma.loan.findFirst({ where: { id, ledgerId } });
    if (!loan) throw new NotFoundException('借贷记录不存在');
    await this.prisma.loan.delete({ where: { id } });
    return { message: '已删除' };
  }

  private async getOrCreateLoanCategory(
    tx: Prisma.TransactionClient,
    ledgerId: string,
  ): Promise<string> {
    const exist = await tx.category.findFirst({
      where: { ledgerId, name: '借贷', parentId: null },
    });
    if (exist) return exist.id;
    const created = await tx.category.create({
      data: {
        name: '借贷',
        type: 'expense',
        ledgerId,
        icon: '🤝',
        isSystem: false,
      },
    });
    return created.id;
  }
}

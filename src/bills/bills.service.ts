import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateBillDto } from './dto/create-bill.dto';
import { UpdateBillDto } from './dto/update-bill.dto';
import { ConvertBillDto } from './dto/convert-bill.dto';
import { QueryBillDto } from './dto/query-bill.dto';
import { buildGroupQuery, groupRange } from './bill-groups';

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
      minAmount, maxAmount, categoryIds, accountIds, userIds, isTransfer, source,
      includeStock,
    } = query;
    const skip = (page - 1) * Number(limit);

    const where: Prisma.BillWhereInput = { ledgerId };
    if (type) where.type = type;
    // 转账过滤：显式要转账 → 只看转账；按类型筛收支 或 显式排除 → 不看转账腿
    if (isTransfer === 'true') {
      where.isTransfer = true;
    } else if (isTransfer === 'false' || type) {
      where.isTransfer = false;
    }
    // 来源过滤：显式指定（如 source='stock' 只看股票盈亏）；
    // 缺省一律排除股票纸面盈亏（未卖出不算真收支，与统计口径一致）；
    // includeStock='true' 时保留（账户详情的余额轨迹需要看到每日结算）
    if (source) {
      where.source = source;
    } else if (includeStock !== 'true') {
      where.source = { not: 'stock' };
    }
    // 分类筛选（多选优先）：一级分类自动带上其子分类（与预算/统计口径一致）
    const catList = (categoryIds ?? categoryId ?? '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
    if (catList.length) {
      const children = await this.prisma.category.findMany({
        where: { parentId: { in: catList } },
        select: { id: true },
      });
      where.categoryId = {
        in: [...catList, ...children.map((c) => c.id)],
      };
    }
    const accList = (accountIds ?? accountId ?? '')
      .split(',').map((x) => x.trim()).filter(Boolean);
    if (accList.length) {
      where.accountId = accList.length === 1 ? accList[0] : { in: accList };
    }
    const userList = (userIds ?? userId ?? '')
      .split(',').map((x) => x.trim()).filter(Boolean);
    if (userList.length) {
      where.userId = userList.length === 1 ? userList[0] : { in: userList };
    }
    if (startDate || endDate) {
      where.date = {};
      const offset = query.timezoneOffset ?? 480;
      if (startDate) (where.date as any).gte = new Date(groupRange(startDate.slice(0, 10), 'day', offset).startAt);
      if (endDate) (where.date as any).lt = new Date(groupRange(endDate.slice(0, 10), 'day', offset).endBefore);
    }
    if (minAmount != null || maxAmount != null) {
      where.amount = {};
      if (minAmount != null) (where.amount as any).gte = minAmount;
      if (maxAmount != null) (where.amount as any).lte = maxAmount;
    }

    if (query.startAt || query.endBefore) {
      where.AND = [{date: {
        ...(query.startAt ? {gte: new Date(query.startAt)} : {}),
        ...(query.endBefore ? {lt: new Date(query.endBefore)} : {}),
      }}];
    }
    if (query.groupBy) {
      const groupLimit = 12;
      const offset = query.timezoneOffset ?? 480;
      const [rows, income, expense] = await Promise.all([
        this.prisma.$queryRaw<Array<{key: string; count: number; income: Prisma.Decimal; expense: Prisma.Decimal}>>(
          buildGroupQuery(where, query.groupBy, offset, groupLimit, query.beforeGroup)),
        this.prisma.bill.aggregate({where: {AND: [where, {type: 'income', isTransfer: false, source: {not: 'stock'}}]}, _sum: {amount: true}}),
        this.prisma.bill.aggregate({where: {AND: [where, {type: 'expense', isTransfer: false, source: {not: 'stock'}}]}, _sum: {amount: true}}),
      ]);
      const groups = rows.slice(0, groupLimit).map(row => ({
        key: row.key, count: row.count,
        income: Number(row.income), expense: Number(row.expense),
        balance: Number(new Prisma.Decimal(row.income).minus(row.expense)),
        ...groupRange(row.key, query.groupBy!, offset),
      }));
      return {groups, nextGroup: rows.length > groupLimit ? groups[groups.length - 1].key : null,
        summary: {totalIncome: Number(income._sum.amount ?? 0), totalExpense: Number(expense._sum.amount ?? 0)}};
    }

    const [bills, total, incomeAgg, expenseAgg] = await Promise.all([
      this.prisma.bill.findMany({
        where, include: BILL_INCLUDE,
        orderBy: [{ date: 'desc' }, { id: 'desc' }], skip, take: Number(limit),
      }),
      this.prisma.bill.count({ where }),
      this.prisma.bill.aggregate({
        // 转账账单与股票纸面盈亏不计入收支汇总（列表默认也不显示股票纸面盈亏）
        where: {
          AND: [where, {type: 'income', isTransfer: false, source: {not: 'stock'}}],
        },
        _sum: { amount: true },
      }),
      this.prisma.bill.aggregate({
        where: {
          AND: [where, {type: 'expense', isTransfer: false, source: {not: 'stock'}}],
        },
        _sum: { amount: true },
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
    const out: any = { bill: this.serialize(bill) };
    // 转账账单：带上配对腿的账户 id（编辑转账表单需要预填对端）
    if (bill.isTransfer) {
      const pair = await this._findTransferPair(this.prisma, bill);
      out.bill.transferPairAccountId = pair?.accountId ?? null;
    }
    return out;
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
      const billDate = dto.date ? new Date(dto.date) : new Date();

      // 补记"历史起点之前"的账单：只把初始余额往前推、不动当前余额。
      // 初始余额快照本就包含那之前的资金状况，再动余额就是双计（与导入自愈同语义）。
      const preHistory = await this._isPreHistory(
        tx, dto.accountId, billDate, null,
      );

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
          date: billDate,
        },
        include: BILL_INCLUDE,
      });

      if (preHistory) {
        // 初始前移：补记支出 → 起点钱更多；补记收入 → 起点钱更少
        await tx.account.update({
          where: { id: dto.accountId },
          data: {
            initialBalance: {
              increment: dto.type === 'income' ? -dto.amount : dto.amount,
            },
          },
        });
      } else if (dto.type === 'income') {
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

  /**
   * 是否"历史起点之前"的账单：早于该账户现有最早账单日期
   * （账户还没有账单时，以账户创建日作为起点）。
   */
  private async _isPreHistory(
    tx: any,
    accountId: string,
    date: Date,
    excludeBillId: string | null,
  ): Promise<boolean> {
    const earliest = await tx.bill.findFirst({
      where: {
        accountId,
        ...(excludeBillId ? { id: { not: excludeBillId } } : {}),
      },
      orderBy: { date: 'asc' },
      select: { date: true },
    });
    let t = earliest?.date;
    if (!t) {
      const acc = await tx.account.findUnique({
        where: { id: accountId },
        select: { createdAt: true },
      });
      t = acc?.createdAt;
    }
    return t != null && date < t;
  }

  async update(ledgerId: string, userId: string, id: string, dto: UpdateBillDto) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.bill.findFirst({ where: { id, ledgerId } });
      if (!existing) throw new NotFoundException('账单不存在');

      // 股票纸面盈亏 / 平仓盈亏由系统维护：纸面不参与余额冲正；平仓账单创建时也不改余额
      if (existing.source === 'stock' || existing.source === 'stock_close') {
        throw new BadRequestException(
          existing.source === 'stock_close'
            ? '平仓盈亏由系统记账，不可修改'
            : '股票盈亏由每日结算自动维护，不可修改；如需调整请改持仓或等下次结算',
        );
      }

      // 转账/借贷类账单（isTransfer）：整条转账（双腿）可编辑——金额/账户/日期
      // 都允许改，但必须找到配对腿同步 + 余额按"冲正旧账 → 记新账"重算；
      // 类型切换（转账→收支）会孤儿化另一条腿，拒绝。
      let transferPair: { id: string; accountId: string } | null = null;
      if (existing.isTransfer) {
        const typeChanged = dto.type !== undefined && dto.type !== existing.type;
        if (typeChanged) {
          throw new BadRequestException(
            '转账账单不可改为收支类型；如需变更请删除后重新记账',
          );
        }
        const amountChanged =
          dto.amount !== undefined && dto.amount !== Number(existing.amount);
        const accountChanged =
          (dto.accountId !== undefined && dto.accountId !== existing.accountId) ||
          dto.toAccountId !== undefined;
        if (amountChanged || accountChanged || dto.date) {
          transferPair = await this._findTransferPair(tx, existing);
          if ((amountChanged || accountChanged) && !transferPair) {
            throw new BadRequestException(
              '未找到配对的转账腿，金额/账户不可修改；如需变更请删除后重新转账',
            );
          }
        }
      }

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
      // 转账编辑：配对腿新账户需存在于本账本（与新建转账的"转入账户"同规则，不限本人）
      if (existing.isTransfer && transferPair && dto.toAccountId) {
        if (dto.toAccountId === (dto.accountId ?? existing.accountId)) {
          throw new BadRequestException('转出和转入账户不能相同');
        }
        const pairAcc = await tx.account.findFirst({
          where: { id: dto.toAccountId, ledgerId },
        });
        if (!pairAcc) throw new NotFoundException('对端账户不存在');
      }

      const oldAmount = Number(existing.amount);
      // 普通账单：旧值逆向 + 新值正向，按"是否历史起点之前"分别落到 余额/初始余额
      // （转账腿的余额调整走下面的"配对同步"逻辑，这里不动）
      if (!existing.isTransfer) {
        const oldPre = await this._isPreHistory(
          tx, existing.accountId, existing.date, existing.id,
        );
        // 撤销旧值
        if (oldPre) {
          await tx.account.update({
            where: { id: existing.accountId },
            data: {
              initialBalance: {
                increment: existing.type === 'income' ? oldAmount : -oldAmount,
              },
            },
          });
        } else if (existing.type === 'income') {
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

      if (!existing.isTransfer) {
        const newDate = dto.date ? new Date(dto.date) : existing.date;
        const newPre = await this._isPreHistory(
          tx, newAccountId, newDate, existing.id,
        );
        // 应用新值
        if (newPre) {
          await tx.account.update({
            where: { id: newAccountId },
            data: {
              initialBalance: {
                increment: newType === 'income' ? -newAmount : newAmount,
              },
            },
          });
        } else if (newType === 'income') {
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
      }

      // 转账编辑：冲正旧双腿余额 → 按新账户/新金额重记，配对腿同步更新
      if (existing.isTransfer && transferPair) {
        const editedIsOut = existing.type === 'expense';
        // 旧账的转出/转入账户
        const oldOutId = editedIsOut ? existing.accountId : transferPair.accountId;
        const oldInId = editedIsOut ? transferPair.accountId : existing.accountId;
        // 新账：被编辑腿用 dto.accountId，配对腿用 dto.toAccountId
        const newEditedAccId = dto.accountId ?? existing.accountId;
        const newPairAccId = dto.toAccountId ?? transferPair.accountId;
        const newOutId = editedIsOut ? newEditedAccId : newPairAccId;
        const newInId = editedIsOut ? newPairAccId : newEditedAccId;

        // 冲正旧账（转出方回补、转入方回吐）
        await tx.account.update({
          where: { id: oldOutId },
          data: { balance: { increment: oldAmount } },
        });
        await tx.account.update({
          where: { id: oldInId },
          data: { balance: { decrement: oldAmount } },
        });
        // 记新账
        await tx.account.update({
          where: { id: newOutId },
          data: { balance: { decrement: newAmount } },
        });
        await tx.account.update({
          where: { id: newInId },
          data: { balance: { increment: newAmount } },
        });

        // 配对腿同步（金额 / 账户 / 日期）
        await tx.bill.update({
          where: { id: transferPair.id },
          data: {
            amount: new Prisma.Decimal(newAmount),
            accountId: newPairAccId,
            ...(dto.date && { date: new Date(dto.date) }),
          },
        });
      }

      // 分类纠正记忆：用户改了导入账单（带商户哈希）的分类 → 记住"该商户 → 新分类"，
      // 下次 AI 导入同商户直接套用，不再重复犯错
      if (
        dto.categoryId &&
        dto.categoryId !== existing.categoryId &&
        existing.merchantHash
      ) {
        await tx.categoryCorrection.upsert({
          where: {
            ledgerId_merchantHash: {
              ledgerId,
              merchantHash: existing.merchantHash,
            },
          },
          create: {
            ledgerId,
            merchantHash: existing.merchantHash,
            categoryId: dto.categoryId,
          },
          update: { categoryId: dto.categoryId },
        });
      }

      return { message: '更新成功', bill: this.serialize(bill) };
    });
  }

  /**
   * 找转账腿的配对腿：同账本、isTransfer、方向相反、同金额、不同账户。
   * 多条候选时（同日多笔同额转账）按"交易日期完全相同优先 → 创建时间最接近"取一条。
   */
  private async _findTransferPair(
    tx: any,
    bill: {
      id: string;
      ledgerId: string;
      accountId: string;
      type: string;
      amount: any;
      date: Date;
      createdAt: Date;
    },
  ): Promise<{ id: string; accountId: string } | null> {
    const candidates = await tx.bill.findMany({
      where: {
        ledgerId: bill.ledgerId,
        isTransfer: true,
        id: { not: bill.id },
        type: bill.type === 'expense' ? 'income' : 'expense',
        amount: new Prisma.Decimal(Number(bill.amount)),
        accountId: { not: bill.accountId },
      },
      select: { id: true, accountId: true, date: true, createdAt: true },
    });
    if (candidates.length === 0) return null;
    const t = bill.date.getTime();
    const createdMs = bill.createdAt.getTime();
    candidates.sort((a: any, b: any) => {
      const da = a.date.getTime() === t ? 0 : 1;
      const db = b.date.getTime() === t ? 0 : 1;
      if (da !== db) return da - db;
      return (
        Math.abs(a.createdAt.getTime() - createdMs) -
        Math.abs(b.createdAt.getTime() - createdMs)
      );
    });
    return { id: candidates[0].id, accountId: candidates[0].accountId };
  }

  /**
   * 把一条普通账单转为「借贷」或「账户间转账」——原地重分类，不重复扣钱。
   * 钱已经在原账单里动过了，这里只把原账单标成转账类(不再计收支)，
   * 再补上借贷记录 / 转账对端，余额保持正确。
   */
  async convert(
    ledgerId: string,
    userId: string,
    id: string,
    dto: ConvertBillDto,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const bill = await tx.bill.findFirst({ where: { id, ledgerId } });
      if (!bill) throw new NotFoundException('账单不存在');
      if (bill.isTransfer) {
        throw new BadRequestException('该账单已是转账/借贷类，无需转换');
      }
      const amount = bill.amount; // Decimal

      if (dto.to === 'loan') {
        // 支出→借出(lend，应收)；收入→借入(borrow，应付)
        const direction = bill.type === 'expense' ? 'lend' : 'borrow';
        const noteCipher =
          dto.noteCipher !== undefined
            ? dto.noteCipher || null
            : bill.noteCipher
              ? Buffer.from(bill.noteCipher).toString('base64')
              : null;
        await tx.loan.create({
          data: {
            ledgerId,
            userId,
            direction,
            amount,
            accountId: bill.accountId,
            noteCipher,
            noteDekVer: dto.noteDekVer ?? bill.noteDekVer,
            date: bill.date,
          },
        });
        const categoryId = await this.getOrCreateLoanCategory(tx, ledgerId);
        await tx.bill.update({
          where: { id },
          data: { isTransfer: true, categoryId },
        });
        return { message: '已转为借贷' };
      }

      // dto.to === 'transfer'：账户间转账
      if (!dto.toAccountId) {
        throw new BadRequestException('请提供转入/转出对端账户');
      }
      const other = await tx.account.findFirst({
        where: { id: dto.toAccountId, ledgerId },
      });
      if (!other) throw new NotFoundException('对端账户不存在');
      if (other.id === bill.accountId) {
        throw new BadRequestException('对端账户不能是本账户');
      }
      // 原账单标转账类（余额已动过，不再调整）
      await tx.bill.update({ where: { id }, data: { isTransfer: true } });
      // 对端建相反方向的转账账单 + 调整对端余额
      const counterType = bill.type === 'expense' ? 'income' : 'expense';
      await tx.bill.create({
        data: {
          ledgerId,
          userId,
          accountId: other.id,
          categoryId: bill.categoryId,
          type: counterType,
          amount,
          noteCipher: Buffer.from('', 'base64'),
          noteDekVer: 1,
          date: bill.date,
          source: bill.source,
          isTransfer: true,
        },
      });
      await tx.account.update({
        where: { id: other.id },
        data:
          counterType === 'income'
            ? { balance: { increment: amount } }
            : { balance: { decrement: amount } },
      });
      return { message: '已转为账户间转账' };
    });
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

  async remove(ledgerId: string, id: string) {
    return this.prisma.$transaction(async (tx) => {
      const bill = await tx.bill.findFirst({ where: { id, ledgerId } });
      if (!bill) throw new NotFoundException('账单不存在');

      // 股票纸面 / 平仓盈亏由系统维护，只读。
      // 纸面结算改余额但流水被对账排除；平仓流水不改余额——删除任一类都会让余额对不上。
      if (bill.source === 'stock' || bill.source === 'stock_close') {
        throw new BadRequestException(
          bill.source === 'stock_close'
            ? '平仓盈亏由系统记账，不可删除'
            : '股票盈亏由每日结算自动维护，不可删除',
        );
      }

      await tx.bill.delete({ where: { id } });

      const amount = Number(bill.amount);
      // 删的是"历史起点之前"的账单 → 回退初始前移，不动当前余额
      const preHistory = await this._isPreHistory(
        tx, bill.accountId, bill.date, bill.id,
      );
      if (preHistory) {
        await tx.account.update({
          where: { id: bill.accountId },
          data: {
            initialBalance: {
              increment: bill.type === 'income' ? amount : -amount,
            },
          },
        });
      } else if (bill.type === 'income') {
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

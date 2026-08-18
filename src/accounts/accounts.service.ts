import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateAccountDto } from './dto/create-account.dto';
import { UpdateAccountDto } from './dto/update-account.dto';
import { TransferDto } from './dto/transfer.dto';
import { ReconcileDto } from './dto/reconcile.dto';

/// 账户访问规则：
/// - 共享账户 (ownerId = null)：账本内所有成员都可读、可写、可删
/// - 私人账户 (ownerId = X)：仅 X 自己可读、可写、可删
@Injectable()
export class AccountsService {
  constructor(private prisma: PrismaService) {}

  async findAll(
    ledgerId: string,
    userId: string,
    scope: 'mine' | 'all' = 'mine',
  ) {
    try {
      await this._catchUpAutoDeposits(ledgerId);
    } catch {
      /* 静默忽略 */
    }

    const where: Prisma.AccountWhereInput =
      scope === 'all'
        ? { ledgerId }
        : { ledgerId, OR: [{ ownerId: null }, { ownerId: userId }] };
    const accounts = await this.prisma.account.findMany({
      where,
      orderBy: [{ ownerId: 'asc' }, { createdAt: 'asc' }],
      include: {
        owner: { select: { id: true, username: true, nickname: true } },
      },
    });

    const enriched = await Promise.all(
      accounts.map(async (a) => {
        const base = this.serialize(a, userId);
        const info = await this._typeInfo(a as any);
        return { ...base, info };
      }),
    );
    return { accounts: enriched };
  }

  async create(ledgerId: string, userId: string, dto: CreateAccountDto) {
    let balance = dto.initialBalance ?? 0;
    if (dto.type === 'CREDIT' && balance !== 0) {
      balance = -Math.abs(balance);
    } else if (dto.type === 'DEBT') {
      if (dto.loanPrincipal != null) {
        const elapsed = monthsBetween(
          dto.firstPaymentDate ? new Date(dto.firstPaymentDate) : null,
          new Date(),
        );
        const remaining = remainingPrincipal({
          method: dto.repaymentMethod ?? 'equal_payment',
          principal: dto.loanPrincipal,
          annualRate: dto.interestRate ?? 0,
          totalMonths: dto.loanTermMonths ?? 0,
          elapsedMonths: elapsed,
        });
        balance = -Math.abs(remaining);
      } else if (balance !== 0) {
        balance = -Math.abs(balance);
      }
    }

    const account = await this.prisma.account.create({
      data: {
        ledgerId,
        ownerId: dto.isShared ? null : userId,
        nameCipher: Buffer.from(dto.nameCipher, 'base64'),
        nameDekVer: dto.nameDekVer,
        type: dto.type,
        balance: new Prisma.Decimal(balance),
        initialBalance: new Prisma.Decimal(balance),
        icon: dto.icon,
        color: dto.color,
        statementDay: dto.statementDay ?? null,
        dueDay: dto.dueDay ?? null,
        creditLimit:
          dto.creditLimit !== undefined
            ? new Prisma.Decimal(dto.creditLimit)
            : null,
        interestRate:
          dto.interestRate !== undefined
            ? new Prisma.Decimal(dto.interestRate)
            : null,
        loanPrincipal:
          dto.loanPrincipal !== undefined
            ? new Prisma.Decimal(dto.loanPrincipal)
            : null,
        loanTermMonths: dto.loanTermMonths ?? null,
        firstPaymentDate: dto.firstPaymentDate
          ? new Date(dto.firstPaymentDate)
          : null,
        repaymentMethod: dto.repaymentMethod ?? null,
        autoDepositDay: dto.autoDepositDay ?? null,
        autoDepositAmount:
          dto.autoDepositAmount !== undefined
            ? new Prisma.Decimal(dto.autoDepositAmount)
            : null,
        autoDepositCategoryId: dto.autoDepositCategoryId ?? null,
        lastAutoProcessedAt: dto.autoDepositDay ? new Date() : null,
      },
      include: {
        owner: { select: { id: true, username: true, nickname: true } },
      },
    });
    return { message: '创建成功', account: this.serialize(account) };
  }

  async update(
    ledgerId: string,
    userId: string,
    id: string,
    dto: UpdateAccountDto,
  ) {
    const existing = await this.findOneOrFail(ledgerId, userId, id);

    const enablingAutoDeposit =
      existing.autoDepositDay == null && dto.autoDepositDay != null;

    const account = await this.prisma.account.update({
      where: { id },
      data: {
        ...(dto.nameCipher !== undefined && {
          nameCipher: Buffer.from(dto.nameCipher, 'base64'),
          nameDekVer: dto.nameDekVer ?? existing.nameDekVer,
        }),
        ...(dto.type && { type: dto.type }),
        ...(dto.icon !== undefined && { icon: dto.icon }),
        ...(dto.color !== undefined && { color: dto.color }),
        ...(dto.isShared !== undefined && {
          ownerId: dto.isShared ? null : userId,
        }),
        ...(dto.statementDay !== undefined && {
          statementDay: dto.statementDay,
        }),
        ...(dto.dueDay !== undefined && { dueDay: dto.dueDay }),
        ...(dto.creditLimit !== undefined && {
          creditLimit:
            dto.creditLimit === null
              ? null
              : new Prisma.Decimal(dto.creditLimit),
        }),
        ...(dto.interestRate !== undefined && {
          interestRate:
            dto.interestRate === null
              ? null
              : new Prisma.Decimal(dto.interestRate),
        }),
        ...(dto.loanPrincipal !== undefined && {
          loanPrincipal:
            dto.loanPrincipal === null
              ? null
              : new Prisma.Decimal(dto.loanPrincipal),
        }),
        ...(dto.loanTermMonths !== undefined && {
          loanTermMonths: dto.loanTermMonths,
        }),
        ...(dto.firstPaymentDate !== undefined && {
          firstPaymentDate: dto.firstPaymentDate
            ? new Date(dto.firstPaymentDate)
            : null,
        }),
        ...(dto.repaymentMethod !== undefined && {
          repaymentMethod: dto.repaymentMethod,
        }),
        ...(dto.autoDepositDay !== undefined && {
          autoDepositDay: dto.autoDepositDay,
        }),
        ...(dto.autoDepositAmount !== undefined && {
          autoDepositAmount:
            dto.autoDepositAmount === null
              ? null
              : new Prisma.Decimal(dto.autoDepositAmount),
        }),
        ...(dto.autoDepositCategoryId !== undefined && {
          autoDepositCategoryId: dto.autoDepositCategoryId,
        }),
        ...(enablingAutoDeposit && { lastAutoProcessedAt: new Date() }),
      },
      include: {
        owner: { select: { id: true, username: true, nickname: true } },
      },
    });
    return { message: '更新成功', account: this.serialize(account) };
  }

  async remove(ledgerId: string, userId: string, id: string) {
    await this.findOneOrFail(ledgerId, userId, id);
    await this.prisma.account.delete({ where: { id } });
    return { message: '删除成功' };
  }

  async transfer(ledgerId: string, userId: string, dto: TransferDto) {
    if (dto.fromAccountId === dto.toAccountId) {
      throw new BadRequestException('转出和转入账户不能相同');
    }
    return this.prisma.$transaction(async (tx) => {
      const from = await tx.account.findFirst({
        where: { id: dto.fromAccountId, ledgerId },
      });
      if (!from) throw new NotFoundException('转出账户不存在');
      this.ensureAccess(from, userId, '转出账户');

      const to = await tx.account.findFirst({
        where: { id: dto.toAccountId, ledgerId },
      });
      if (!to) throw new NotFoundException('转入账户不存在');

      const amount = new Prisma.Decimal(dto.amount);

      // 生成两条可见转账流水（转出 expense / 转入 income，都标 isTransfer），
      // 便于查询资金轨迹；isTransfer 已在统计/预算里排除，不污染收支。
      // 备注密文由客户端用账本 DEK 加密后传来（服务端不持有 DEK）。
      if (dto.fromNoteCipher && dto.toNoteCipher && dto.noteDekVer) {
        const categoryId = await this.getOrCreateTransferCategory(tx, ledgerId);
        const now = new Date();
        await tx.bill.create({
          data: {
            ledgerId,
            userId,
            accountId: from.id,
            categoryId,
            type: 'expense',
            amount,
            noteCipher: Buffer.from(dto.fromNoteCipher, 'base64'),
            noteDekVer: dto.noteDekVer,
            date: now,
            source: 'transfer',
            isTransfer: true,
          },
        });
        await tx.bill.create({
          data: {
            ledgerId,
            userId,
            accountId: to.id,
            categoryId,
            type: 'income',
            amount,
            noteCipher: Buffer.from(dto.toNoteCipher, 'base64'),
            noteDekVer: dto.noteDekVer,
            date: now,
            source: 'transfer',
            isTransfer: true,
          },
        });
      }

      const updatedFrom = await tx.account.update({
        where: { id: from.id },
        data: { balance: { decrement: amount } },
        include: {
          owner: { select: { id: true, username: true, nickname: true } },
        },
      });
      const updatedTo = await tx.account.update({
        where: { id: to.id },
        data: { balance: { increment: amount } },
        include: {
          owner: { select: { id: true, username: true, nickname: true } },
        },
      });
      return {
        message: '转账成功',
        from: this.serialize(updatedFrom),
        to: this.serialize(updatedTo),
      };
    });
  }

  /**
   * 校准余额：用户填入真实余额，服务端按 diff 生成一条「余额调整」审计账单
   * （isTransfer=true，已在统计/预算排除），并把账户余额精确设为真实值。
   * diff>0 记 income、diff<0 记 expense；备注密文由客户端用账本 DEK 加密后传来。
   */
  async reconcile(
    ledgerId: string,
    userId: string,
    id: string,
    dto: ReconcileDto,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const account = await tx.account.findFirst({
        where: { id, ledgerId },
      });
      if (!account) throw new NotFoundException('账户不存在');
      this.ensureAccess(account, userId);
      if (account.type === 'DEBT') {
        throw new BadRequestException('负债账户的余额由还款计划推导，不支持校准');
      }

      const target = new Prisma.Decimal(String(dto.actualBalance));
      const diff = target.minus(account.balance);
      if (diff.isZero()) {
        return { message: '余额一致，无需校准', account: this.serialize(account) };
      }

      const categoryId = await this.getOrCreateBalanceAdjustCategory(
        tx,
        ledgerId,
      );
      await tx.bill.create({
        data: {
          ledgerId,
          userId,
          accountId: account.id,
          categoryId,
          type: diff.gt(0) ? 'income' : 'expense',
          amount: diff.abs(),
          noteCipher: Buffer.from(dto.noteCipher ?? '', 'base64'),
          noteDekVer: dto.noteDekVer ?? 1,
          date: new Date(),
          source: 'reconcile',
          isTransfer: true,
        },
      });

      const updated = await tx.account.update({
        where: { id: account.id },
        data: { balance: target },
        include: {
          owner: { select: { id: true, username: true, nickname: true } },
        },
      });
      return { message: '校准成功', account: this.serialize(updated) };
    });
  }

  /** 取或建本账本的「余额调整」分类（校准流水挂靠用；isTransfer 已排除统计，分类仅作展示） */
  private async getOrCreateBalanceAdjustCategory(
    tx: Prisma.TransactionClient,
    ledgerId: string,
  ): Promise<string> {
    const exist = await tx.category.findFirst({
      where: { ledgerId, name: '余额调整', parentId: null },
    });
    if (exist) return exist.id;
    const created = await tx.category.create({
      data: {
        name: '余额调整',
        type: 'expense',
        ledgerId,
        icon: '⚖️',
        isSystem: false,
      },
    });
    return created.id;
  }

  /** 取或建本账本的「转账」分类（转账流水挂靠用；isTransfer 已排除统计，分类仅作展示） */
  private async getOrCreateTransferCategory(
    tx: Prisma.TransactionClient,
    ledgerId: string,
  ): Promise<string> {
    const exist = await tx.category.findFirst({
      where: { ledgerId, name: '转账', parentId: null },
    });
    if (exist) return exist.id;
    const created = await tx.category.create({
      data: {
        name: '转账',
        type: 'expense',
        ledgerId,
        icon: '🔄',
        isSystem: false,
      },
    });
    return created.id;
  }

  private async findOneOrFail(ledgerId: string, userId: string, id: string) {
    const account = await this.prisma.account.findFirst({
      where: { id, ledgerId },
    });
    if (!account) throw new NotFoundException('账户不存在');
    this.ensureAccess(account, userId);
    return account;
  }

  private ensureAccess(account: any, userId: string, label = '账户') {
    if (account.ownerId !== null && account.ownerId !== userId) {
      throw new ForbiddenException(`无权操作他人的私人${label}`);
    }
  }

  private serialize(account: any, viewerId?: string) {
    const ownerNick = (account.owner?.nickname ?? '').trim();
    const ownerDisplay =
      ownerNick.length > 0 ? ownerNick : (account.owner?.username ?? null);
    const balanceVisible =
      account.ownerId === null ||
      viewerId === undefined ||
      account.ownerId === viewerId;
    return {
      id: account.id,
      ledgerId: account.ledgerId,
      ownerId: account.ownerId ?? null,
      ownerName: account.owner?.username ?? null,
      ownerNickname: account.owner?.nickname ?? null,
      ownerDisplayName: ownerDisplay,
      isShared: account.ownerId === null,
      // 账户名密文（客户端用账本 DEK 解）
      nameCipher: account.nameCipher
        ? Buffer.from(account.nameCipher).toString('base64')
        : null,
      nameDekVer: account.nameDekVer,
      type: account.type,
      balance: balanceVisible ? Number(account.balance) : 0,
      initialBalance:
          balanceVisible ? Number(account.initialBalance ?? 0) : 0,
      balanceVisible,
      icon: account.icon,
      color: account.color,
      statementDay: account.statementDay ?? null,
      dueDay: account.dueDay ?? null,
      creditLimit:
        account.creditLimit != null ? Number(account.creditLimit) : null,
      interestRate:
        account.interestRate != null ? Number(account.interestRate) : null,
      loanPrincipal:
        account.loanPrincipal != null ? Number(account.loanPrincipal) : null,
      loanTermMonths: account.loanTermMonths ?? null,
      firstPaymentDate: account.firstPaymentDate ?? null,
      repaymentMethod: account.repaymentMethod ?? null,
      autoDepositDay: account.autoDepositDay ?? null,
      autoDepositAmount:
        account.autoDepositAmount != null
          ? Number(account.autoDepositAmount)
          : null,
      autoDepositCategoryId: account.autoDepositCategoryId ?? null,
      lastAutoProcessedAt: account.lastAutoProcessedAt ?? null,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
    };
  }

  // ─────────────────────────────────────────────────────────────
  // 类型衍生信息（同前，未变化部分省略注释）
  // ─────────────────────────────────────────────────────────────
  private async _typeInfo(a: any): Promise<any | null> {
    if (a.type === 'CREDIT' && a.statementDay && a.dueDay) return this._creditCardInfo(a);
    if (a.type === 'DEBT' && a.dueDay) return this._debtInfo(a);
    if ((a.type === 'INSURANCE' || a.autoDepositDay) && a.autoDepositDay && a.autoDepositAmount) {
      return this._autoDepositInfo(a);
    }
    return null;
  }

  private async _creditCardInfo(a: any) {
    const today = startOfDay(new Date());
    const stmtDay = a.statementDay as number;
    const dueDay = a.dueDay as number;
    const lastStmt = lastOccurrenceOf(stmtDay, today);
    const prevStmt = addMonths(lastStmt, -1);
    const periodStart = prevStmt;
    const periodEnd = lastStmt;
    let dueDate = new Date(
      lastStmt.getFullYear(),
      lastStmt.getMonth(),
      Math.min(dueDay, daysInMonth(lastStmt.getFullYear(), lastStmt.getMonth())),
    );
    if (dueDate <= lastStmt) {
      dueDate = new Date(
        lastStmt.getFullYear(),
        lastStmt.getMonth() + 1,
        Math.min(dueDay, daysInMonth(lastStmt.getFullYear(), lastStmt.getMonth() + 1)),
      );
    }
    // 本期账单 = 出账日开始前的总欠款；出账日当天消费进入下一期。
    // 不能只加账期窗口内的支出：开户带进来的「初始欠款」也在这期账单里
    // （例：初始欠 901.11 + 账期内消费 953.35 → 真实账单 1854.46）。
    const [expAgg, incAgg] = await Promise.all([
      this.prisma.bill.aggregate({
        where: { accountId: a.id, ledgerId: a.ledgerId, type: 'expense', date: { lt: periodEnd } },
        _sum: { amount: true },
      }),
      this.prisma.bill.aggregate({
        where: { accountId: a.id, ledgerId: a.ledgerId, type: 'income', date: { lt: periodEnd } },
        _sum: { amount: true },
      }),
    ]);
    const balAtStmt =
      Number(a.initialBalance ?? 0) +
      Number(incAgg._sum.amount || 0) -
      Number(expAgg._sum.amount || 0);
    const periodBill = Math.max(0, -balAtStmt);
    const balance = Number(a.balance);
    const owed = balance < 0 ? -balance : 0;
    const ongoingAgg = await this.prisma.bill.aggregate({
      where: { accountId: a.id, ledgerId: a.ledgerId, type: 'expense', date: { gte: periodEnd, lte: endOfDay(today) } },
      _sum: { amount: true },
    });
    const ongoingSpent = Number(ongoingAgg._sum.amount || 0);
    // 未还 = 当前总欠款刨掉「下期未出账」的部分（还款先冲抵本期已出账）。
    // 之前误用 periodBill − owed：未出账也被当成本期没还，还清了仍显示"未还/逾期"。
    const unpaid = Math.max(0, owed - ongoingSpent);
    const paid = Math.max(0, periodBill - unpaid);
    let nextStmt = new Date(today.getFullYear(), today.getMonth(), Math.min(stmtDay, daysInMonth(today.getFullYear(), today.getMonth())));
    if (nextStmt <= today) {
      nextStmt = new Date(today.getFullYear(), today.getMonth() + 1, Math.min(stmtDay, daysInMonth(today.getFullYear(), today.getMonth() + 1)));
    }
    // 本期已还清且还款日已过 → 「下次还款」滚到下一期（下个账单日之后的还款日），
    // 避免显示"剩 -11 天"这种已完结账期的负倒计时
    if (unpaid < 0.01 && dueDate < today) {
      dueDate = new Date(
        nextStmt.getFullYear(),
        nextStmt.getMonth(),
        Math.min(dueDay, daysInMonth(nextStmt.getFullYear(), nextStmt.getMonth())),
      );
      if (dueDate <= nextStmt) {
        dueDate = new Date(
          nextStmt.getFullYear(),
          nextStmt.getMonth() + 1,
          Math.min(dueDay, daysInMonth(nextStmt.getFullYear(), nextStmt.getMonth() + 1)),
        );
      }
    }
    const daysToDue = Math.ceil((dueDate.getTime() - today.getTime()) / 86400000);
    return {
      kind: 'credit',
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
      periodBill, paid, unpaid,
      dueDate: dueDate.toISOString(), daysToDue,
      isOverdue: unpaid > 0 && daysToDue < 0,
      isDueToday: unpaid > 0 && daysToDue === 0,
      isDueTomorrow: unpaid > 0 && daysToDue === 1,
      ongoingSpent, nextStatementDate: nextStmt.toISOString(),
      creditLimit: a.creditLimit != null ? Number(a.creditLimit) : null,
    };
  }

  private _debtInfo(a: any) {
    const today = startOfDay(new Date());
    const dueDay = a.dueDay as number;
    let next = new Date(today.getFullYear(), today.getMonth(), Math.min(dueDay, daysInMonth(today.getFullYear(), today.getMonth())));
    if (next <= today) next = new Date(today.getFullYear(), today.getMonth() + 1, Math.min(dueDay, daysInMonth(today.getFullYear(), today.getMonth() + 1)));
    const daysToDue = Math.ceil((next.getTime() - today.getTime()) / 86400000);
    const balance = Number(a.balance);
    const owed = balance < 0 ? -balance : balance;
    const rate = a.interestRate != null ? Number(a.interestRate) : 0;
    const monthlyInterest = (owed * (rate / 100)) / 12;
    const principal = a.loanPrincipal != null ? Number(a.loanPrincipal) : 0;
    const totalMonths = a.loanTermMonths ?? 0;
    const elapsed = monthsBetween(a.firstPaymentDate ?? null, today);
    const method = (a.repaymentMethod as string) ?? 'equal_payment';
    const payment = principal > 0 && totalMonths > 0
      ? monthlyPaymentFor({ method, principal, annualRate: rate, totalMonths, periodIndex: Math.max(1, Math.min(elapsed + 1, totalMonths)) })
      : null;
    return {
      kind: 'debt',
      dueDate: next.toISOString(), daysToDue, owed,
      interestRate: rate, monthlyInterest: Number(monthlyInterest.toFixed(2)),
      monthlyPayment: payment != null ? Number(payment.toFixed(2)) : null,
      paidPeriods: Math.max(0, Math.min(elapsed, totalMonths || elapsed)),
      totalPeriods: totalMonths,
      isDueToday: daysToDue === 0, isDueTomorrow: daysToDue === 1,
    };
  }

  private _autoDepositInfo(a: any) {
    const today = startOfDay(new Date());
    const day = a.autoDepositDay as number;
    let next = new Date(today.getFullYear(), today.getMonth(), Math.min(day, daysInMonth(today.getFullYear(), today.getMonth())));
    if (next <= today) next = new Date(today.getFullYear(), today.getMonth() + 1, Math.min(day, daysInMonth(today.getFullYear(), today.getMonth() + 1)));
    return {
      kind: 'auto_deposit',
      nextDepositDate: next.toISOString(),
      lastDepositDate: a.lastAutoProcessedAt ? new Date(a.lastAutoProcessedAt).toISOString() : null,
      amount: Number(a.autoDepositAmount || 0),
    };
  }

  // 自动入账补漏：用 noteDekVer=0 写"系统占位"密文（0 字节 buf）
  // 客户端见 noteDekVer===0 时显示"自动入账"，不尝试解密
  private async _catchUpAutoDeposits(ledgerId: string) {
    const accounts = await this.prisma.account.findMany({
      where: { ledgerId, autoDepositDay: { not: null }, autoDepositAmount: { not: null } },
    });
    if (accounts.length === 0) return;

    let defaultCat: { id: string } | null = await this.prisma.category.findFirst({
      where: { name: '其他收入', isSystem: true },
    });
    if (!defaultCat) {
      defaultCat = await this.prisma.category.findFirst({ where: { isSystem: true, type: 'income' } });
    }

    const ledger = await this.prisma.ledger.findUnique({
      where: { id: ledgerId },
      select: { ownerId: true },
    });

    const systemNoteCipher = Buffer.alloc(0); // 0 字节占位
    for (const a of accounts) {
      const categoryId = a.autoDepositCategoryId ?? defaultCat?.id ?? null;
      if (!categoryId) continue;
      const since = a.lastAutoProcessedAt ?? a.createdAt;
      const periods = missedDepositPeriods(since, new Date(), a.autoDepositDay!);
      if (periods.length === 0) continue;
      const amount = new Prisma.Decimal(a.autoDepositAmount as any);
      const userId = a.ownerId ?? ledger?.ownerId;
      if (!userId) continue;
      for (const periodDate of periods) {
        try {
          await this.prisma.$transaction(async (tx) => {
            await tx.bill.create({
              data: {
                ledgerId, userId, accountId: a.id, categoryId,
                type: 'income', amount,
                noteCipher: systemNoteCipher,
                noteDekVer: 0,  // 0 = 系统占位
                date: periodDate,
                source: 'auto_deposit',
                autoDepositPeriod: periodDate,
              } as any,
            });
            await tx.account.update({
              where: { id: a.id },
              data: { balance: { increment: amount }, lastAutoProcessedAt: periodDate },
            });
          });
        } catch (error) {
          if (
            !(error instanceof Prisma.PrismaClientKnownRequestError) ||
            error.code !== 'P2002'
          ) {
            throw error;
          }
          // 另一请求已创建同一账户/周期的账单。推进游标，避免以后反复重试，
          // 但绝不再次增加余额；lt 条件也防止并发请求把游标倒退。
          await this.prisma.account.updateMany({
            where: {
              id: a.id,
              OR: [
                { lastAutoProcessedAt: null },
                { lastAutoProcessedAt: { lt: periodDate } },
              ],
            },
            data: { lastAutoProcessedAt: periodDate },
          });
        }
      }
    }
  }
}

// ── 日期 / 计算工具（不变） ────────────────────────────────
function startOfDay(d: Date): Date { const x = new Date(d); x.setHours(0,0,0,0); return x; }
function endOfDay(d: Date): Date { const x = new Date(d); x.setHours(23,59,59,999); return x; }
function addDays(d: Date, n: number): Date { const x = new Date(d); x.setDate(x.getDate()+n); return x; }
function addMonths(d: Date, n: number): Date { const x = new Date(d); x.setMonth(x.getMonth()+n); return x; }
function daysInMonth(year: number, month0: number): number { return new Date(year, month0+1, 0).getDate(); }

function lastOccurrenceOf(day: number, today: Date): Date {
  const y = today.getFullYear(); const m = today.getMonth();
  const thisMonth = new Date(y, m, Math.min(day, daysInMonth(y, m)));
  if (thisMonth <= today) return thisMonth;
  const prev = new Date(y, m - 1, 1);
  return new Date(prev.getFullYear(), prev.getMonth(), Math.min(day, daysInMonth(prev.getFullYear(), prev.getMonth())));
}

function monthsBetween(a: Date | null | undefined, b: Date): number {
  if (!a) return 0;
  const d = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
  if (b.getDate() < a.getDate()) return Math.max(0, d - 1);
  return Math.max(0, d);
}

function monthlyPaymentFor(args: { method: string; principal: number; annualRate: number; totalMonths: number; periodIndex: number; }): number {
  const { method, principal: P, annualRate, totalMonths: n, periodIndex } = args;
  const r = annualRate / 100 / 12;
  if (method === 'equal_principal') {
    const monthlyPrin = P / n;
    const remainingBefore = P - monthlyPrin * (periodIndex - 1);
    return monthlyPrin + remainingBefore * r;
  }
  if (method === 'interest_only') {
    if (periodIndex >= n) return P + P * r;
    return P * r;
  }
  if (r === 0) return P / n;
  const pow = Math.pow(1 + r, n);
  return (P * r * pow) / (pow - 1);
}

function remainingPrincipal(args: { method: string; principal: number; annualRate: number; totalMonths: number; elapsedMonths: number; }): number {
  const { method, principal: P, annualRate, totalMonths: n, elapsedMonths: k } = args;
  if (k <= 0 || n <= 0) return P;
  if (k >= n) return 0;
  const r = annualRate / 100 / 12;
  if (method === 'equal_principal') return P - (P / n) * k;
  if (method === 'interest_only') return P;
  if (r === 0) return P - (P / n) * k;
  const powN = Math.pow(1 + r, n);
  const powK = Math.pow(1 + r, k);
  return (P * (powN - powK)) / (powN - 1);
}

function missedDepositPeriods(since: Date, today: Date, depositDay: number): Date[] {
  const out: Date[] = [];
  const start = startOfDay(since);
  const end = endOfDay(today);
  let y = start.getFullYear(); let m = start.getMonth();
  let candidate = new Date(y, m, Math.min(depositDay, daysInMonth(y, m)));
  if (candidate <= start) candidate = new Date(y, m + 1, Math.min(depositDay, daysInMonth(y, m + 1)));
  while (candidate <= end) {
    out.push(candidate);
    const ny = candidate.getFullYear(); const nm = candidate.getMonth() + 1;
    candidate = new Date(ny, nm, Math.min(depositDay, daysInMonth(ny, nm)));
  }
  return out;
}

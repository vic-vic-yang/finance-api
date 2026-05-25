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

/// 账户访问规则：
/// - 共享账户 (ownerId = null)：账本内所有成员都可读、可写、可删
/// - 私人账户 (ownerId = X)：仅 X 自己可读、可写、可删
@Injectable()
export class AccountsService {
  constructor(private prisma: PrismaService) {}

  /**
   * 列出账户。
   *  - scope = 'mine'（默认）：仅返回共享 + 当前用户自己的私人账户
   *  - scope = 'all'：返回账本下全部账户（含其他成员的私人账户），
   *    但他人私人账户的 balance 会被隐藏。
   *
   * 副作用：每次调用会顺便补齐"自动入账"账户漏掉的入账（社保/公积金等）。
   * 这样不依赖定时任务，只要用户登录看一次账户页就能把过去几个月的入账补全。
   */
  async findAll(
    ledgerId: string,
    userId: string,
    scope: 'mine' | 'all' = 'mine',
  ) {
    // 顺手做自动入账补漏（容错：即使失败也不阻塞账户列表）
    try {
      await this._catchUpAutoDeposits(ledgerId);
    } catch {
      // 静默忽略，下次请求再试
    }

    const where: Prisma.AccountWhereInput =
      scope === 'all'
        ? { ledgerId }
        : { ledgerId, OR: [{ ownerId: null }, { ownerId: userId }] };
    const accounts = await this.prisma.account.findMany({
      where,
      orderBy: [{ ownerId: 'asc' }, { createdAt: 'asc' }],
      include: { owner: { select: { id: true, username: true, nickname: true } } },
    });

    // 计算每个信用卡 / 负债 / 自动入账账户的衍生信息
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
    // 信用卡 / 负债账户的余额约定：负数 = 欠款。
    let balance = dto.initialBalance ?? 0;
    if (dto.type === 'CREDIT' && balance !== 0) {
      balance = -Math.abs(balance);
    } else if (dto.type === 'DEBT') {
      // 负债账户：余额由"贷款本金 + 还款方式 + 已过期数"自动算出剩余欠款，
      // 用户不必再填"当前欠款金额"。
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
        name: dto.name,
        type: dto.type,
        balance: new Prisma.Decimal(balance),
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
      include: { owner: { select: { id: true, username: true, nickname: true } } },
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

    // 如果用户从"非自动入账"切换到"自动入账"，初始化 lastAutoProcessedAt
    const enablingAutoDeposit =
      existing.autoDepositDay == null && dto.autoDepositDay != null;

    const account = await this.prisma.account.update({
      where: { id },
      data: {
        ...(dto.name && { name: dto.name }),
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
      include: { owner: { select: { id: true, username: true, nickname: true } } },
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
      const updatedFrom = await tx.account.update({
        where: { id: from.id },
        data: { balance: { decrement: amount } },
        include: { owner: { select: { id: true, username: true, nickname: true } } },
      });
      const updatedTo = await tx.account.update({
        where: { id: to.id },
        data: { balance: { increment: amount } },
        include: { owner: { select: { id: true, username: true, nickname: true } } },
      });
      return {
        message: '转账成功',
        from: this.serialize(updatedFrom),
        to: this.serialize(updatedTo),
      };
    });
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
      ownerNick.length > 0
        ? ownerNick
        : (account.owner?.username ?? null);
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
      name: account.name,
      type: account.type,
      balance: balanceVisible ? Number(account.balance) : 0,
      balanceVisible,
      icon: account.icon,
      color: account.color,
      // 类型相关配置
      statementDay: account.statementDay ?? null,
      dueDay: account.dueDay ?? null,
      creditLimit:
        account.creditLimit != null ? Number(account.creditLimit) : null,
      interestRate:
        account.interestRate != null ? Number(account.interestRate) : null,
      loanPrincipal:
        account.loanPrincipal != null
          ? Number(account.loanPrincipal)
          : null,
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
  // 类型相关的衍生信息（每个账户随 GET /accounts 一并下发）
  // ─────────────────────────────────────────────────────────────
  private async _typeInfo(a: any): Promise<any | null> {
    if (a.type === 'CREDIT' && a.statementDay && a.dueDay) {
      return this._creditCardInfo(a);
    }
    if (a.type === 'DEBT' && a.dueDay) {
      return this._debtInfo(a);
    }
    if (
      (a.type === 'INSURANCE' || a.autoDepositDay) &&
      a.autoDepositDay &&
      a.autoDepositAmount
    ) {
      return this._autoDepositInfo(a);
    }
    return null;
  }

  /// 信用卡：算出本期账单 / 还款日 / 已还 / 距还款日天数
  private async _creditCardInfo(a: any) {
    const today = startOfDay(new Date());
    const stmtDay = a.statementDay as number;
    const dueDay = a.dueDay as number;

    // 最近一个 *已经发生* 的账单日
    const lastStmt = lastOccurrenceOf(stmtDay, today);
    // 上一个账单日（再往前一个月）
    const prevStmt = addMonths(lastStmt, -1);
    // 本期账单覆盖周期：(prevStmt, lastStmt]
    const periodStart = addDays(prevStmt, 1);
    const periodEnd = endOfDay(lastStmt);

    // 还款日：lastStmt 之后第一个落在 dueDay 的日子
    let dueDate = new Date(
      lastStmt.getFullYear(),
      lastStmt.getMonth(),
      Math.min(dueDay, daysInMonth(lastStmt.getFullYear(), lastStmt.getMonth())),
    );
    if (dueDate <= lastStmt) {
      dueDate = new Date(
        lastStmt.getFullYear(),
        lastStmt.getMonth() + 1,
        Math.min(
          dueDay,
          daysInMonth(lastStmt.getFullYear(), lastStmt.getMonth() + 1),
        ),
      );
    }

    // 当期账单 = 周期内的 expense 总额
    const billAgg = await this.prisma.bill.aggregate({
      where: {
        accountId: a.id,
        ledgerId: a.ledgerId,
        type: 'expense',
        date: { gte: periodStart, lte: periodEnd },
      },
      _sum: { amount: true },
    });
    const periodBill = Number(billAgg._sum.amount || 0);

    // 已还 = 账单日之后的 income/收款（含从其他账户转入）
    // 现存的 Bill 表里 type='income' 即增加该卡余额；转账走 transfer 接口直接改余额
    // 转账没有 Bill 记录，所以单凭 Bill 不能准确判断还款。
    // 折中：用本期账单日之后 *credit 账户余额变化* 作为已还参考。
    //   - balance 变 0 或正：说明上期欠款已抹平
    //   - 仍为负数：abs(balance) 即仍欠款
    const balance = Number(a.balance);
    // 信用卡：balance 为负数 = 欠款；正/0 = 无欠款
    const owed = balance < 0 ? -balance : 0;
    // 已还（估算）= periodBill - owed，限制非负
    const paid = Math.max(0, periodBill - owed);
    const unpaid = Math.max(0, periodBill - paid);

    const daysToDue = Math.ceil(
      (dueDate.getTime() - today.getTime()) / 86400000,
    );

    // 未出账（当前还在记账的下一期）= 本次 lastStmt 之后到今天的 expense
    const ongoingAgg = await this.prisma.bill.aggregate({
      where: {
        accountId: a.id,
        ledgerId: a.ledgerId,
        type: 'expense',
        date: { gt: periodEnd, lte: endOfDay(today) },
      },
      _sum: { amount: true },
    });
    const ongoingSpent = Number(ongoingAgg._sum.amount || 0);

    // 下一个出账日
    let nextStmt = new Date(
      today.getFullYear(),
      today.getMonth(),
      Math.min(stmtDay, daysInMonth(today.getFullYear(), today.getMonth())),
    );
    if (nextStmt <= today) {
      nextStmt = new Date(
        today.getFullYear(),
        today.getMonth() + 1,
        Math.min(
          stmtDay,
          daysInMonth(today.getFullYear(), today.getMonth() + 1),
        ),
      );
    }

    return {
      kind: 'credit',
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
      periodBill,
      paid,
      unpaid,
      dueDate: dueDate.toISOString(),
      daysToDue,
      isOverdue: unpaid > 0 && daysToDue < 0,
      isDueToday: unpaid > 0 && daysToDue === 0,
      isDueTomorrow: unpaid > 0 && daysToDue === 1,
      ongoingSpent,
      nextStatementDate: nextStmt.toISOString(),
      creditLimit:
        a.creditLimit != null ? Number(a.creditLimit) : null,
    };
  }

  /// 负债账户：下一个还款日 + 月供 + 已还期数 + 简单月息
  private _debtInfo(a: any) {
    const today = startOfDay(new Date());
    const dueDay = a.dueDay as number;
    let next = new Date(
      today.getFullYear(),
      today.getMonth(),
      Math.min(dueDay, daysInMonth(today.getFullYear(), today.getMonth())),
    );
    if (next <= today) {
      next = new Date(
        today.getFullYear(),
        today.getMonth() + 1,
        Math.min(
          dueDay,
          daysInMonth(today.getFullYear(), today.getMonth() + 1),
        ),
      );
    }
    const daysToDue = Math.ceil(
      (next.getTime() - today.getTime()) / 86400000,
    );
    const balance = Number(a.balance);
    const owed = balance < 0 ? -balance : balance;
    const rate = a.interestRate != null ? Number(a.interestRate) : 0;
    const monthlyInterest = (owed * (rate / 100)) / 12;

    // 按还款方式 + 本金 + 期数 + 利率 算月供
    const principal =
      a.loanPrincipal != null ? Number(a.loanPrincipal) : 0;
    const totalMonths = a.loanTermMonths ?? 0;
    const elapsed = monthsBetween(a.firstPaymentDate ?? null, today);
    const method = (a.repaymentMethod as string) ?? 'equal_payment';
    const payment =
      principal > 0 && totalMonths > 0
        ? monthlyPaymentFor({
            method,
            principal,
            annualRate: rate,
            totalMonths,
            periodIndex: Math.max(1, Math.min(elapsed + 1, totalMonths)),
          })
        : null;

    return {
      kind: 'debt',
      dueDate: next.toISOString(),
      daysToDue,
      owed,
      interestRate: rate,
      monthlyInterest: Number(monthlyInterest.toFixed(2)),
      monthlyPayment: payment != null ? Number(payment.toFixed(2)) : null,
      paidPeriods: Math.max(0, Math.min(elapsed, totalMonths || elapsed)),
      totalPeriods: totalMonths,
      isDueToday: daysToDue === 0,
      isDueTomorrow: daysToDue === 1,
    };
  }

  /// 自动入账：下一次入账日 + 上次入账时间
  private _autoDepositInfo(a: any) {
    const today = startOfDay(new Date());
    const day = a.autoDepositDay as number;
    let next = new Date(
      today.getFullYear(),
      today.getMonth(),
      Math.min(day, daysInMonth(today.getFullYear(), today.getMonth())),
    );
    if (next <= today) {
      next = new Date(
        today.getFullYear(),
        today.getMonth() + 1,
        Math.min(
          day,
          daysInMonth(today.getFullYear(), today.getMonth() + 1),
        ),
      );
    }
    return {
      kind: 'auto_deposit',
      nextDepositDate: next.toISOString(),
      lastDepositDate: a.lastAutoProcessedAt
        ? new Date(a.lastAutoProcessedAt).toISOString()
        : null,
      amount: Number(a.autoDepositAmount || 0),
    };
  }

  // ─────────────────────────────────────────────────────────────
  // 自动入账补漏：找出所有需要补的入账日，生成 Bill 并更新余额
  // ─────────────────────────────────────────────────────────────
  private async _catchUpAutoDeposits(ledgerId: string) {
    const accounts = await this.prisma.account.findMany({
      where: {
        ledgerId,
        autoDepositDay: { not: null },
        autoDepositAmount: { not: null },
      },
    });
    if (accounts.length === 0) return;

    // 找一个默认入账分类（找不到则跳过该账户）
    let defaultCat: { id: string } | null = await this.prisma.category.findFirst({
      where: { name: '其他收入', isSystem: true },
    });
    if (!defaultCat) {
      defaultCat = await this.prisma.category.findFirst({
        where: { isSystem: true, type: 'income' },
      });
    }

    // 账本 owner，用于给共享账户的自动入账记账人
    const ledger = await this.prisma.ledger.findUnique({
      where: { id: ledgerId },
      select: { ownerId: true },
    });

    for (const a of accounts) {
      const categoryId =
        a.autoDepositCategoryId ?? defaultCat?.id ?? null;
      if (!categoryId) continue;

      const since = a.lastAutoProcessedAt ?? a.createdAt;
      const periods = missedDepositPeriods(
        since,
        new Date(),
        a.autoDepositDay!,
      );
      if (periods.length === 0) continue;

      const amount = new Prisma.Decimal(a.autoDepositAmount as any);
      const userId = a.ownerId ?? ledger?.ownerId;
      if (!userId) continue;

      for (const periodDate of periods) {
        await this.prisma.$transaction([
          this.prisma.bill.create({
            data: {
              ledgerId,
              userId,
              accountId: a.id,
              categoryId,
              type: 'income',
              amount,
              note: '自动入账',
              date: periodDate,
            },
          }),
          this.prisma.account.update({
            where: { id: a.id },
            data: {
              balance: { increment: amount },
              lastAutoProcessedAt: periodDate,
            },
          }),
        ]);
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────
// 日期工具
// ─────────────────────────────────────────────────────────────
function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function endOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function addMonths(d: Date, n: number): Date {
  const x = new Date(d);
  x.setMonth(x.getMonth() + n);
  return x;
}

function daysInMonth(year: number, month0: number): number {
  // month0 可能越界（11+1=12），new Date 会自动归一化
  return new Date(year, month0 + 1, 0).getDate();
}

/// 找到 <= today 且最近的"day 号"
function lastOccurrenceOf(day: number, today: Date): Date {
  const y = today.getFullYear();
  const m = today.getMonth();
  const dayCapped = Math.min(day, daysInMonth(y, m));
  const thisMonth = new Date(y, m, dayCapped);
  if (thisMonth <= today) return thisMonth;
  const prev = new Date(y, m - 1, 1);
  const py = prev.getFullYear();
  const pm = prev.getMonth();
  return new Date(py, pm, Math.min(day, daysInMonth(py, pm)));
}

/// 两个日期之间相隔多少个整月（按"月初到月初"近似，向下取整）
function monthsBetween(a: Date | null | undefined, b: Date): number {
  if (!a) return 0;
  const d = (b.getFullYear() - a.getFullYear()) * 12 +
    (b.getMonth() - a.getMonth());
  // 如果 b 这个月还没到 a 的日，则减 1
  if (b.getDate() < a.getDate()) return Math.max(0, d - 1);
  return Math.max(0, d);
}

/// 当期月供：根据还款方式 / 本金 / 年利率 / 总月数 / 第 k 期
function monthlyPaymentFor(args: {
  method: string;
  principal: number;
  annualRate: number; // %
  totalMonths: number;
  periodIndex: number; // 1-based
}): number {
  const { method, principal: P, annualRate, totalMonths: n, periodIndex } = args;
  const r = annualRate / 100 / 12;

  if (method === 'equal_principal') {
    // 等额本金：每月本金 = P/n，利息 = 剩余本金 × r
    const monthlyPrin = P / n;
    const remainingBefore = P - monthlyPrin * (periodIndex - 1);
    return monthlyPrin + remainingBefore * r;
  }

  if (method === 'interest_only') {
    // 先息后本：除最后一期外仅还利息；最后一期还利息 + 本金
    if (periodIndex >= n) return P + P * r;
    return P * r;
  }

  // equal_payment（等额本息，默认）
  if (r === 0) return P / n;
  const pow = Math.pow(1 + r, n);
  return (P * r * pow) / (pow - 1);
}

/// 按还款方式计算"已过 elapsedMonths 之后剩余本金"
function remainingPrincipal(args: {
  method: string;
  principal: number;
  annualRate: number; // %
  totalMonths: number;
  elapsedMonths: number;
}): number {
  const { method, principal: P, annualRate, totalMonths: n, elapsedMonths: k } = args;
  if (k <= 0 || n <= 0) return P;
  if (k >= n) return 0;
  const r = annualRate / 100 / 12;

  if (method === 'equal_principal') {
    return P - (P / n) * k;
  }
  if (method === 'interest_only') {
    return P; // 期间不还本金
  }
  // equal_payment
  if (r === 0) return P - (P / n) * k;
  const powN = Math.pow(1 + r, n);
  const powK = Math.pow(1 + r, k);
  return (P * (powN - powK)) / (powN - 1);
}

/// 计算自动入账要补的日期列表
/// 从 [since, today] 区间内，所有落在 depositDay 的日子
function missedDepositPeriods(
  since: Date,
  today: Date,
  depositDay: number,
): Date[] {
  const out: Date[] = [];
  const start = startOfDay(since);
  const end = endOfDay(today);

  // 从 since 后的第一个 depositDay 开始
  let y = start.getFullYear();
  let m = start.getMonth();

  // 当月的 depositDay
  let candidate = new Date(
    y,
    m,
    Math.min(depositDay, daysInMonth(y, m)),
  );
  // 若 candidate <= since，跳到下个月
  if (candidate <= start) {
    candidate = new Date(
      y,
      m + 1,
      Math.min(depositDay, daysInMonth(y, m + 1)),
    );
  }

  while (candidate <= end) {
    out.push(candidate);
    const ny = candidate.getFullYear();
    const nm = candidate.getMonth() + 1;
    candidate = new Date(ny, nm, Math.min(depositDay, daysInMonth(ny, nm)));
  }
  return out;
}

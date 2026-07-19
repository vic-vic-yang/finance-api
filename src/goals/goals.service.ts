import {
  Injectable, NotFoundException, ForbiddenException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LedgersService } from '../ledgers/ledgers.service';
import { CreateGoalDto } from './dto/create-goal.dto';
import { UpdateGoalDto } from './dto/update-goal.dto';

/**
 * 储蓄目标。独立模块，不依赖 AI。
 *
 * 两种进度模式：
 *  - 绑定账户（accountId 不为空）：用账户余额自动计算
 *    progress = (balance - initialBalance) / targetAmount
 *  - 未绑定账户（accountId 为空）：用账本收支净额计算
 *    progress = (income - expense) / targetAmount
 */
@Injectable()
export class GoalsService {
  constructor(
    private prisma: PrismaService,
    private ledgers: LedgersService,
  ) {}

  async findAll(userId: string, ledgerId: string) {
    await this.ledgers.ensureMembership(userId, ledgerId);
    const goals = await this.prisma.savingsGoal.findMany({
      where: { userId, ledgerId },
      orderBy: { createdAt: 'desc' },
    });
    const enriched = await Promise.all(
      goals.map((g) => this._withProgress(g)),
    );
    return { goals: enriched };
  }

  async create(userId: string, ledgerId: string, dto: CreateGoalDto) {
    await this.ledgers.ensureMembership(userId, ledgerId);

    let initialBalance: Prisma.Decimal | null = null;
    if (dto.accountId) {
      const account = await this.prisma.account.findFirst({
        where: { id: dto.accountId, ledgerId },
      });
      if (!account) throw new NotFoundException('账户不存在');
      // 默认 true：计入现有余额
      const useExisting = dto.useExistingBalance !== false;
      initialBalance = useExisting
        ? new Prisma.Decimal(0)
        : account.balance;
    }

    const created = await this.prisma.savingsGoal.create({
      data: {
        userId,
        ledgerId,
        nameCipher: Buffer.from(dto.nameCipher, 'base64'),
        nameDekVer: dto.nameDekVer,
        targetAmount: new Prisma.Decimal(dto.targetAmount),
        startDate: dto.startDate ? new Date(dto.startDate) : new Date(),
        accountId: dto.accountId ?? null,
        initialBalance,
        deadline: dto.deadline ? new Date(dto.deadline) : null,
        icon: dto.icon ?? null,
        color: dto.color ?? null,
      },
    });
    return { message: '创建成功', goal: await this._withProgress(created) };
  }

  async update(userId: string, id: string, dto: UpdateGoalDto) {
    const exist = await this.prisma.savingsGoal.findUnique({ where: { id } });
    if (!exist) throw new NotFoundException('目标不存在');
    if (exist.userId !== userId) throw new ForbiddenException('只能改自己的目标');

    const data: Prisma.SavingsGoalUpdateInput = {};
    if (dto.nameCipher !== undefined) {
      data.nameCipher = Buffer.from(dto.nameCipher, 'base64');
    }
    if (dto.nameDekVer !== undefined) data.nameDekVer = dto.nameDekVer;
    if (dto.targetAmount !== undefined) {
      data.targetAmount = new Prisma.Decimal(dto.targetAmount);
    }
    if (dto.startDate !== undefined) data.startDate = new Date(dto.startDate);

    // 账户绑定变更
    if (dto.accountId !== undefined) {
      if (dto.accountId) {
        const account = await this.prisma.account.findFirst({
          where: { id: dto.accountId, ledgerId: exist.ledgerId },
        });
        if (!account) throw new NotFoundException('账户不存在');
        data.account = { connect: { id: dto.accountId } };
        const useExisting = dto.useExistingBalance !== false;
        data.initialBalance = useExisting
          ? new Prisma.Decimal(0)
          : account.balance;
      } else {
        // 传空串 = 解绑
        data.account = { disconnect: true };
        data.initialBalance = null;
      }
    } else if (dto.useExistingBalance !== undefined && exist.accountId) {
      // 不改账户但改了 useExistingBalance
      const account = await this.prisma.account.findFirst({
        where: { id: exist.accountId, ledgerId: exist.ledgerId },
      });
      if (account) {
        data.initialBalance = dto.useExistingBalance
          ? new Prisma.Decimal(0)
          : account.balance;
      }
    }

    if (dto.deadline !== undefined) {
      data.deadline = dto.deadline ? new Date(dto.deadline) : null;
    }
    if (dto.icon !== undefined) data.icon = dto.icon;
    if (dto.color !== undefined) data.color = dto.color;
    if (dto.isCompleted !== undefined) {
      data.isCompleted = dto.isCompleted;
      data.completedAt = dto.isCompleted ? new Date() : null;
    }

    const updated = await this.prisma.savingsGoal.update({
      where: { id },
      data,
    });
    return { message: '更新成功', goal: await this._withProgress(updated) };
  }

  async remove(userId: string, id: string) {
    const exist = await this.prisma.savingsGoal.findUnique({ where: { id } });
    if (!exist) throw new NotFoundException('目标不存在');
    if (exist.userId !== userId) throw new ForbiddenException('只能删自己的目标');
    await this.prisma.savingsGoal.delete({ where: { id } });
    return { message: '已删除' };
  }

  /** 计算进度。绑定账户时用余额，否则用收支净额。 */
  private async _withProgress(g: any) {
    const now = new Date();
    const target = this._toNum(g.targetAmount);

    let saved: number;
    let accountInfo: any = null;

    if (g.accountId) {
      const account = await this.prisma.account.findUnique({
        where: { id: g.accountId },
      });
      if (account) {
        const balance = this._toNum(account.balance);
        const initial = this._toNum(g.initialBalance);
        // Math.max 防止信用/负债账户负余额导致进度为负
        saved = Math.max(0, balance - initial);

        const balanceVisible =
          account.ownerId === null || account.ownerId === g.userId;
        accountInfo = {
          id: account.id,
          nameCipher: account.nameCipher
            ? Buffer.from(account.nameCipher).toString('base64')
            : null,
          nameDekVer: account.nameDekVer,
          balance: balanceVisible ? balance : 0,
          balanceVisible,
        };
      } else {
        saved = await this._savedFromBills(g);
      }
    } else {
      saved = await this._savedFromBills(g);
    }

    const progress = target > 0 ? Math.max(0, Math.min(saved / target, 999)) : 0;

    let etaDays: number | null = null;
    if (saved < target) {
      const start: Date = g.startDate;
      const daysSinceStart =
        Math.max(1, (now.getTime() - start.getTime()) / 86_400_000);
      const dailyRate = saved / daysSinceStart;
      if (dailyRate > 0) {
        etaDays = Math.ceil((target - saved) / dailyRate);
      }
    }

    const initialVal = this._toNum(g.initialBalance);

    return {
      id: g.id,
      ledgerId: g.ledgerId,
      userId: g.userId,
      nameCipher: Buffer.from(g.nameCipher).toString('base64'),
      nameDekVer: g.nameDekVer,
      targetAmount: target,
      currentSaved: saved,
      progress,
      etaDays,
      startDate: g.startDate,
      deadline: g.deadline,
      icon: g.icon,
      color: g.color,
      isCompleted: g.isCompleted,
      completedAt: g.completedAt,
      accountId: g.accountId ?? null,
      initialBalance: g.initialBalance != null ? initialVal : null,
      useExistingBalance: g.accountId ? initialVal === 0 : null,
      account: accountInfo,
      createdAt: g.createdAt,
      updatedAt: g.updatedAt,
    };
  }

  /** 安全转 number：处理 Prisma Decimal | null | undefined | number */
  private _toNum(v: any): number {
    if (v === null || v === undefined) return 0;
    if (typeof v === 'number') return v;
    if (typeof v === 'string') return parseFloat(v) || 0;
    // Prisma Decimal 或任何带 toNumber 的对象
    if (typeof v.toNumber === 'function') return v.toNumber();
    return Number(v);
  }

  /** 旧逻辑：从 startDate 起的 (收入 - 支出) */
  private async _savedFromBills(g: any): Promise<number> {
    const now = new Date();
    const start: Date = g.startDate;
    // 只算真收支：转账（账户互转）与股票纸面盈亏都不是"存下来的钱"
    const base = {
      ledgerId: g.ledgerId,
      isTransfer: false,
      source: { not: 'stock' as const },
      date: { gte: start, lte: now },
    };
    const [incAgg, expAgg] = await Promise.all([
      this.prisma.bill.aggregate({
        where: { ...base, type: 'income' },
        _sum: { amount: true },
      }),
      this.prisma.bill.aggregate({
        where: { ...base, type: 'expense' },
        _sum: { amount: true },
      }),
    ]);
    const income = Number(incAgg._sum.amount ?? 0);
    const expense = Number(expAgg._sum.amount ?? 0);
    return income - expense;
  }
}
